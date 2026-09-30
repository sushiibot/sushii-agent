import type { ChatMessage, PendingApproval, PhotoDraft } from '$lib/agent/types';
import { ChatHttpError, httpChatApi, type ChatApi } from './api';
import {
	MESSAGE_TEXT_MAX,
	MESSAGE_UPLOADS_MAX,
	type ChatEnvelope,
	type WorkspaceState
} from './events';
import { drafts, outbox, type KeyValue, type OutboxEntry } from './outbox';
import { jpegName, PhotoError, preparePhoto } from './photo';
import { toMessages } from './project';
import {
	addLocalSend,
	addPlaceholder,
	applyEvent,
	createState,
	markAsk,
	mergeHistory,
	openTurns,
	removeLocal,
	setDelivery,
	type ChatItem,
	type ChatState,
	type Effect
} from './reduce';
import { fetchSse, type ChatTransport, type TransportState } from './transport';
import { ulid } from './ulid';

const HISTORY_PAGE = 40;
const TOAST_MS = 4000;
const TIMEOUT_COLLAPSE_MS = 4000;
const SEEN_DEBOUNCE_MS = 1000;
/** A 202 with no status this long after means a duplicate the router had already handled. */
const UNACKED_MS = 60_000;
const RETRY_MS = 30_000;

interface Photo extends PhotoDraft {
	uploadClientId: string;
	uploadId?: string;
	bytes?: number;
	file: Blob;
}

export interface ChatStoreDeps {
	transport?: ChatTransport;
	api?: ChatApi;
	outbox?: KeyValue<OutboxEntry>;
	drafts?: KeyValue<{ id: string; text: string }>;
}

export class ChatStore {
	#s: ChatState = createState();
	#transport: ChatTransport;
	#api: ChatApi;
	#outbox: KeyValue<OutboxEntry>;
	#drafts: KeyValue<{ id: string; text: string }>;

	items = $state.raw<readonly ChatItem[]>([]);
	messages = $state.raw<ChatMessage[]>([]);
	approvals = $state.raw<PendingApproval[]>([]);
	timedOut = $state.raw<PendingApproval | null>(null);
	cursor = $state<number | null>(null);
	workspace = $state<WorkspaceState | null>(null);
	connection = $state<TransportState | 'connecting'>('connecting');
	reconnectingSince = $state<number | null>(null);
	/** Set after a `reset` reload, until the reader has seen the banner for a while. */
	reset = $state(false);
	history = $state<'loading' | 'ready' | 'error'>('loading');
	olderLoading = $state(false);
	hasOlder = $state(false);
	stopping = $state(false);
	toast = $state<string | null>(null);
	/** Screen-reader text, set once per completed reply. */
	announce = $state('');
	photos = $state<Photo[]>([]);
	quotaFull = $state(false);
	trayPhase = $state<'ready' | 'submitting'>('ready');
	draft = $state('');

	openTurns = $derived(new Map(this.#openTurnList().map((t) => [t.turnId ?? t.id, t] as const)));
	running = $derived(this.openTurns.size > 0);

	#before: string | null = null;
	#buffer: ChatEnvelope[] | null = [];
	#queue: ChatEnvelope[] = [];
	#frame: number | null = null;
	#pending = new Map<string, OutboxEntry>();
	#inflight = new Set<string>();
	#failed = new Set<string>();
	#unacked = new Map<string, ReturnType<typeof setTimeout>>();
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#toastTimer: ReturnType<typeof setTimeout> | null = null;
	#timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	#seenTimer: ReturnType<typeof setTimeout> | null = null;
	#seenSent = 0;
	#draftTimer: ReturnType<typeof setTimeout> | null = null;
	#disconnect: (() => void) | null = null;
	#cleanup: (() => void)[] = [];

	constructor(deps: ChatStoreDeps = {}) {
		this.#transport = deps.transport ?? fetchSse();
		this.#api = deps.api ?? httpChatApi;
		this.#outbox = deps.outbox ?? outbox;
		this.#drafts = deps.drafts ?? drafts;
	}

	#openTurnList() {
		// Reads `items` so the derived map follows every commit.
		void this.items;
		return openTurns(this.#s);
	}

	async start() {
		if (this.#disconnect) return;
		this.#disconnect = this.#transport.connect(
			null,
			(ev) => this.apply(ev),
			(state) => this.#onTransport(state)
		);
		const onOnline = () => this.#flushOutbox();
		const onVisible = () => {
			if (document.visibilityState === 'visible') this.#scheduleSeen();
		};
		addEventListener('online', onOnline);
		document.addEventListener('visibilitychange', onVisible);
		this.#cleanup.push(
			() => removeEventListener('online', onOnline),
			() => document.removeEventListener('visibilitychange', onVisible)
		);

		const [entries, saved] = await Promise.all([
			this.#outbox.all().catch(() => []),
			this.#drafts.all().catch(() => [])
		]);
		const draft = saved.find((d) => d.id === 'main')?.text;
		if (draft && !this.draft) this.draft = draft;
		for (const e of entries.sort((a, b) => a.at.localeCompare(b.at))) {
			this.#pending.set(e.clientId, e);
			addLocalSend(this.#s, {
				clientId: e.clientId,
				text: e.text,
				attachments: e.uploadIds.map((id) => ({
					name: 'Photo',
					ref: { id, contentType: 'image/jpeg', bytes: 0, name: 'Photo', inline: true }
				})),
				at: e.at,
				delivery: 'sending'
			});
		}
		this.#commit();
		await this.#loadHistory();
	}

	destroy() {
		this.#disconnect?.();
		this.#disconnect = null;
		for (const f of this.#cleanup.splice(0)) f();
		for (const t of this.#unacked.values()) clearTimeout(t);
		for (const t of [
			this.#retryTimer,
			this.#toastTimer,
			this.#timeoutTimer,
			this.#seenTimer,
			this.#draftTimer
		]) {
			if (t) clearTimeout(t);
		}
		if (this.#frame !== null) cancelAnimationFrame(this.#frame);
	}

	/** Queues an event; everything queued lands in one DOM update per animation frame. */
	apply(ev: ChatEnvelope) {
		if (this.#buffer && ev.type !== 'hello' && ev.type !== 'reset') {
			this.#buffer.push(ev);
			return;
		}
		this.#queue.push(ev);
		if (this.#frame !== null) return;
		if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
			this.#frame = requestAnimationFrame(() => this.#flush());
		} else {
			this.#frame = setTimeout(() => this.#flush(), 16) as unknown as number;
		}
	}

	#flush() {
		this.#frame = null;
		const queue = this.#queue.splice(0);
		const fx: Effect[] = [];
		for (const ev of queue) fx.push(...applyEvent(this.#s, ev));
		this.#commit();
		for (const e of fx) this.#effect(e);
		this.#scheduleSeen();
	}

	#commit() {
		const s = this.#s;
		this.items = [...s.items];
		this.messages = toMessages(s.items, {
			stopping: s.stopping,
			historyGap: this.history === 'error'
		});
		this.approvals = s.approvals.map((a) => ({ nonce: a.nonce, view: a.view }));
		this.timedOut = s.timedOut;
		this.cursor = s.cursor;
		this.workspace = s.workspace;
		this.stopping = s.stopping;
	}

	#effect(e: Effect) {
		switch (e.type) {
			case 'delivered': {
				this.#pending.delete(e.clientId);
				this.#failed.delete(e.clientId);
				clearTimeout(this.#unacked.get(e.clientId));
				this.#unacked.delete(e.clientId);
				void this.#outbox.delete(e.clientId).catch(() => {});
				break;
			}
			case 'workspace':
				if (e.state === 'online') this.#flushOutbox();
				break;
			case 'toast':
				this.showToast(e.text);
				break;
			case 'announce':
				// Clear first so the same words announce again.
				this.announce = '';
				queueMicrotask(() => (this.announce = e.text));
				break;
			case 'reload':
				this.reset = true;
				setTimeout(() => (this.reset = false), 10_000);
				this.#buffer = [];
				void this.#loadHistory();
				break;
			case 'timedOut':
				if (this.#timeoutTimer) clearTimeout(this.#timeoutTimer);
				this.#timeoutTimer = setTimeout(() => {
					this.#s.timedOut = null;
					this.#commit();
				}, TIMEOUT_COLLAPSE_MS);
				break;
		}
	}

	#onTransport(state: TransportState) {
		if (state === 'reconnecting') this.reconnectingSince ??= Date.now();
		else this.reconnectingSince = null;
		this.connection = state;
		if (state === 'open') this.#flushOutbox();
	}

	showToast(text: string) {
		this.toast = text;
		if (this.#toastTimer) clearTimeout(this.#toastTimer);
		this.#toastTimer = setTimeout(() => (this.toast = null), TOAST_MS);
	}

	// ── History ──

	async #loadHistory() {
		this.history = 'loading';
		this.#commit();
		const r = await this.#api.history({ limit: HISTORY_PAGE });
		if (r.ok) {
			mergeHistory(this.#s, r.page.items);
			this.#before = r.page.before;
			this.hasOlder = r.page.before !== null;
			this.history = 'ready';
		} else {
			this.history = 'error';
		}
		const buffered = this.#buffer ?? [];
		this.#buffer = null;
		this.#queue.unshift(...buffered);
		this.#flush();
		this.#flushOutbox();
	}

	async loadOlder() {
		if (this.olderLoading || !this.#before) return;
		this.olderLoading = true;
		const r = await this.#api.history({ before: this.#before, limit: HISTORY_PAGE });
		this.olderLoading = false;
		if (!r.ok) {
			this.showToast("Couldn't load earlier messages. Try again in a moment.");
			return;
		}
		mergeHistory(this.#s, r.page.items);
		this.#before = r.page.before;
		this.hasOlder = r.page.before !== null;
		this.#commit();
	}

	retryHistory() {
		if (this.history !== 'error') return;
		this.#buffer = [];
		void this.#loadHistory();
	}

	// ── Sending ──

	setDraft(text: string) {
		this.draft = text;
		if (this.#draftTimer) clearTimeout(this.#draftTimer);
		this.#draftTimer = setTimeout(() => {
			void this.#drafts.put({ id: 'main', text }).catch(() => {});
		}, 300);
	}

	get sendBlocked(): boolean {
		return this.photos.some((p) => p.state !== 'uploaded');
	}

	/** Sends text plus the attached photos. `files` attaches more first and waits for their uploads. */
	async send(text: string, files: File[] = []): Promise<boolean> {
		if (files.length) {
			await Promise.all(this.attach(files));
		}
		const body = text.trim();
		if (this.sendBlocked || (!body && !this.photos.length)) return false;
		if (body.length > MESSAGE_TEXT_MAX) {
			this.showToast('That message is too long. The limit is 16,000 characters.');
			return false;
		}
		const photos = this.photos;
		const entry: OutboxEntry = {
			clientId: ulid(),
			text: body,
			uploadIds: photos.map((p) => p.uploadId!),
			at: new Date().toISOString(),
			posted: false
		};
		addLocalSend(this.#s, {
			clientId: entry.clientId,
			text: entry.text,
			attachments: photos.map((p) => ({
				name: p.name,
				preview: p.src,
				ref: {
					id: p.uploadId!,
					contentType: 'image/jpeg',
					bytes: p.bytes ?? 0,
					name: p.name,
					inline: true
				}
			})),
			at: entry.at,
			delivery: 'sending'
		});
		this.photos = [];
		this.quotaFull = false;
		this.setDraft('');
		this.#commit();
		this.#pending.set(entry.clientId, entry);
		await this.#outbox.put(entry).catch(() => {});
		await this.#deliver(entry);
		return true;
	}

	async #deliver(entry: OutboxEntry) {
		const id = entry.clientId;
		if (this.#inflight.has(id) || !this.#pending.has(id)) return;
		this.#inflight.add(id);
		this.#failed.delete(id);
		setDelivery(this.#s, id, 'sending');
		this.#commit();
		try {
			await this.#api.postMessage({
				clientId: id,
				text: entry.text,
				...(entry.uploadIds.length ? { uploadIds: entry.uploadIds } : {})
			});
			if (!this.#pending.has(id)) return;
			entry.posted = true;
			void this.#outbox.put(entry).catch(() => {});
			if (this.workspace === 'offline') setDelivery(this.#s, id, 'queued-agent');
			clearTimeout(this.#unacked.get(id));
			this.#unacked.set(
				id,
				setTimeout(() => {
					if (!this.#pending.has(id) || this.workspace !== 'online') return;
					this.#effect({ type: 'delivered', clientId: id });
					setDelivery(this.#s, id, 'sent');
					this.#commit();
				}, UNACKED_MS)
			);
		} catch (err) {
			if (!this.#pending.has(id)) return;
			const e = err instanceof ChatHttpError ? err : new ChatHttpError(0, String(err));
			if (e.retryable) {
				setDelivery(this.#s, id, e.status === 0 && !navigator.onLine ? 'queued' : 'queued-agent');
				this.#scheduleRetry();
			} else {
				this.#failed.add(id);
				setDelivery(this.#s, id, 'failed');
			}
		} finally {
			this.#inflight.delete(id);
			this.#commit();
		}
	}

	#scheduleRetry() {
		if (this.#retryTimer) return;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			this.#flushOutbox();
		}, RETRY_MS);
	}

	#flushOutbox() {
		if (this.#buffer) return;
		for (const entry of this.#pending.values()) {
			if (this.#failed.has(entry.clientId)) continue;
			void this.#deliver(entry);
		}
	}

	/** Re-sends a failed message with the same client id, so the bot can dedupe it. */
	retry(messageId: string) {
		const clientId = this.#clientIdOf(messageId);
		const entry = clientId && this.#pending.get(clientId);
		if (entry) void this.#deliver(entry);
	}

	/** Deletes an unsent message. */
	discard(messageId: string) {
		const clientId = this.#clientIdOf(messageId);
		if (!clientId || !this.#pending.has(clientId)) return;
		this.#pending.delete(clientId);
		this.#failed.delete(clientId);
		void this.#outbox.delete(clientId).catch(() => {});
		removeLocal(this.#s, clientId);
		this.#commit();
	}

	#clientIdOf(messageId: string) {
		const item = this.#s.items.find((i) => i.id === messageId);
		return item?.kind === 'user' ? item.clientId : undefined;
	}

	// ── Photos ──

	/** Resizes and uploads each photo; resolves when all have settled. */
	attach(files: File[]): Promise<void>[] {
		const room = MESSAGE_UPLOADS_MAX - this.photos.length;
		if (files.length > room) {
			this.showToast(`Up to ${MESSAGE_UPLOADS_MAX} photos per message.`);
		}
		return files.slice(0, Math.max(0, room)).map((file) => {
			const photo: Photo = {
				id: ulid(),
				uploadClientId: ulid(),
				name: jpegName(file.name),
				src: URL.createObjectURL(file),
				state: 'preparing',
				file
			};
			this.photos = [...this.photos, photo];
			return this.#upload(photo.id);
		});
	}

	#patchPhoto(id: string, patch: Partial<Photo>) {
		this.photos = this.photos.map((p) => (p.id === id ? { ...p, ...patch } : p));
	}

	async #upload(id: string) {
		const photo = this.photos.find((p) => p.id === id);
		if (!photo) return;
		let blob: Blob;
		try {
			this.#patchPhoto(id, { state: 'preparing', error: undefined, progress: undefined });
			blob = await preparePhoto(photo.file);
		} catch (err) {
			this.#patchPhoto(id, {
				state: 'failed',
				error: err instanceof PhotoError ? err.reason : 'type'
			});
			return;
		}
		if (!this.photos.some((p) => p.id === id)) return;
		this.#patchPhoto(id, { state: 'uploading', progress: 0 });
		try {
			const res = await this.#api.upload(
				blob,
				{ name: photo.name, clientId: photo.uploadClientId },
				(pct) => this.#patchPhoto(id, { progress: pct })
			);
			this.#patchPhoto(id, {
				state: 'uploaded',
				uploadId: res.id,
				bytes: res.bytes,
				progress: 100
			});
		} catch (err) {
			const status = err instanceof ChatHttpError ? err.status : 0;
			if (status === 507) this.quotaFull = true;
			this.#patchPhoto(id, {
				state: 'failed',
				error: status === 413 ? 'size' : status === 415 ? 'type' : 'upload'
			});
		}
	}

	removePhoto(id: string) {
		const photo = this.photos.find((p) => p.id === id);
		if (photo) URL.revokeObjectURL(photo.src);
		this.photos = this.photos.filter((p) => p.id !== id);
		if (!this.photos.some((p) => p.state === 'failed')) this.quotaFull = false;
	}

	retryPhoto(id: string) {
		void this.#upload(id);
	}

	// ── Commands, asks, approvals ──

	async stopTurn() {
		const turn = [...this.openTurns.values()].at(-1);
		this.#s.stopping = true;
		this.#commit();
		try {
			await this.#api.stop(turn?.turnId);
		} catch {
			this.#s.stopping = false;
			this.#commit();
			this.showToast("Couldn't reach the agent to stop the turn. Try again.");
		}
	}

	async command(command: 'new' | 'compact') {
		if (command === 'new') addPlaceholder(this.#s, Date.now(), 'Starting a new chat…');
		if (command === 'compact') addPlaceholder(this.#s, Date.now(), 'Compacting…');
		this.#commit();
		try {
			await this.#api.command(command);
		} catch {
			this.#s.items = this.#s.items.filter((i) => i.id !== 'turn:pending');
			this.#commit();
			this.showToast("Couldn't reach the agent to run the command. Try again.");
		}
	}

	async answer(askId: string, answer: string) {
		const ask = this.#s.items.find((i) => i.kind === 'ask' && i.askId === askId);
		if (ask?.kind !== 'ask') return;
		const index = ask.choices.indexOf(answer);
		markAsk(this.#s, askId, answer);
		this.#commit();
		try {
			const r = await this.#api.answerAsk(
				askId,
				index >= 0 ? { index, label: answer } : { text: answer }
			);
			if (r.status === 'inactive') {
				ask.state = 'history';
				this.showToast('That question is no longer waiting for an answer.');
			} else if (r.status === 'failed') {
				markAsk(this.#s, askId, null);
				this.showToast("Your answer didn't reach the agent. Try again.");
			}
		} catch {
			markAsk(this.#s, askId, null);
			this.showToast("Couldn't send your answer. Check your connection and try again.");
		}
		this.#commit();
	}

	async decide(nonce: string, decision: 'approve' | 'deny') {
		this.#s.mine.add(`p:${nonce}`);
		this.trayPhase = 'submitting';
		try {
			const r = await this.#api.decide(nonce, { decision });
			if (r.status === 'expired') this.showToast('That approval had already expired.');
		} catch {
			this.showToast("Couldn't send your decision. Check your connection and try again.");
		} finally {
			this.trayPhase = 'ready';
		}
	}

	// ── Presence ──

	#scheduleSeen() {
		if (document.visibilityState !== 'visible') return;
		const seq = this.#s.cursor;
		if (seq === null || seq <= this.#seenSent) return;
		if (this.#seenTimer) clearTimeout(this.#seenTimer);
		this.#seenTimer = setTimeout(() => {
			this.#seenTimer = null;
			const now = this.#s.cursor;
			if (now === null || now <= this.#seenSent || document.visibilityState !== 'visible') return;
			this.#seenSent = now;
			void this.#api.seen(now).catch(() => {
				this.#seenSent = 0;
			});
		}, SEEN_DEBOUNCE_MS);
	}
}
