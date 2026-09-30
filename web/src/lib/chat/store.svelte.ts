import type { ChatMessage, PendingApproval, PhotoDraft } from '$lib/agent/types';
import { ChatHttpError, httpChatApi, uploadMissingIds, type ChatApi } from './api';
import {
	MESSAGE_TEXT_MAX,
	MESSAGE_UPLOADS_MAX,
	type ChatEnvelope,
	type WorkspaceState
} from './events';
import {
	drafts,
	outbox,
	requestPersistence,
	type Draft,
	type DraftPhoto,
	type KeyValue,
	type OutboxEntry
} from './outbox';
import { photoName, PhotoError, preparePhoto } from './photo';
import { toMessages } from './project';
import {
	addLocalSend,
	addPlaceholder,
	applyEvent,
	createState,
	dropApproval,
	markAsk,
	mergeHistory,
	openTurns,
	removeLocal,
	restartHistory,
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
/** A 202'd message with no receipt this long after is posted again; the bot routes it or says it already did. */
const UNACKED_MS = 60_000;
const RETRY_MS = 30_000;
/** The server GCs unreferenced uploads after 24h; re-upload well before that. */
const REUPLOAD_AFTER_MS = 20 * 60 * 60 * 1000;
/** How long start() waits for the stream's first frame before loading history anyway. */
const HELLO_WAIT_MS = 3000;
const DRAFT_DEBOUNCE_MS = 300;
const NOT_OWNER = "This device isn't signed in as the owner.";

function uploadError(status: number): NonNullable<PhotoDraft['error']> {
	if (status === 413) return 'size';
	if (status === 415 || status === 422) return 'type';
	if (status === 429) return 'daily';
	return 'upload';
}

interface Photo extends PhotoDraft {
	uploadId?: string;
	uploadedAt?: number;
	/** The resized image, kept for re-uploads and saved with the draft. */
	blob?: Blob;
	bytes?: number;
	file: Blob;
	/** X-Client-Id for this photo's upload; the same across retries so the server dedupes them. */
	key: string;
}

export interface ChatStoreDeps {
	transport?: ChatTransport;
	api?: ChatApi;
	outbox?: KeyValue<OutboxEntry>;
	drafts?: KeyValue<Draft>;
}

export class ChatStore {
	#s: ChatState = createState();
	#transport: ChatTransport;
	#api: ChatApi;
	#outbox: KeyValue<OutboxEntry>;
	#drafts: KeyValue<Draft>;

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
	/** The last older page failed; the top of the list offers Retry instead of loading on scroll. */
	olderError = $state(false);
	stopping = $state(false);
	toast = $state<string | null>(null);
	/** Screen-reader text, set once per completed reply. */
	announce = $state('');
	photos = $state<Photo[]>([]);
	quotaFull = $state(false);
	trayPhase = $state<'ready' | 'submitting'>('ready');
	draft = $state('');
	/** Main is on screen. `seen` suppresses pushes, so it must only go out while the reader can see the chat. */
	viewing = $state(false);

	openTurns = $derived(new Map(this.#openTurnList().map((t) => [t.turnId ?? t.id, t] as const)));
	running = $derived(this.openTurns.size > 0);

	#before: string | null = null;
	#buffer: ChatEnvelope[] | null = [];
	#queue: ChatEnvelope[] = [];
	#frame: number | null = null;
	#pending = new Map<string, OutboxEntry>();
	#inflight = new Set<string>();
	#failed = new Set<string>();
	/** Posted entries whose resend failed with a retryable error, so the retry timer covers them. */
	#retrying = new Set<string>();
	#greeted: Promise<void>;
	#draftRestored = false;
	#greet: () => void = () => {};
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
		this.#greeted = new Promise((r) => (this.#greet = r));
	}

	#openTurnList() {
		// Reads `items` so the derived map follows every commit.
		void this.items;
		return openTurns(this.#s);
	}

	async start() {
		if (this.#disconnect) return;
		requestPersistence();
		this.#disconnect = this.#transport.connect(
			null,
			(ev) => this.apply(ev),
			(state) => this.#onTransport(state)
		);
		const onOnline = () => this.#flushOutbox(false);
		const onVisibility = () => {
			if (document.visibilityState === 'visible') this.#scheduleSeen();
			else this.#saveDraft();
		};
		const onPageHide = () => this.#saveDraft();
		addEventListener('online', onOnline);
		addEventListener('pagehide', onPageHide);
		document.addEventListener('visibilitychange', onVisibility);
		this.#cleanup.push(
			() => removeEventListener('online', onOnline),
			() => removeEventListener('pagehide', onPageHide),
			() => document.removeEventListener('visibilitychange', onVisibility)
		);

		const [entries, saved] = await Promise.all([
			this.#outbox.all().catch(() => []),
			this.#drafts.all().catch(() => [])
		]);
		const draft = saved.find((d) => d.id === 'main');
		if (draft?.text && !this.draft) this.draft = draft.text;
		if (draft?.photos?.length && !this.photos.length) this.#restorePhotos(draft.photos);
		this.#draftRestored = true;
		for (const e of entries.sort((a, b) => a.at.localeCompare(b.at))) {
			this.#pending.set(e.clientId, e);
			addLocalSend(this.#s, {
				clientId: e.clientId,
				text: e.text,
				attachments: e.uploadIds.map((id, i) => {
					const photo = e.photos?.[i];
					return {
						name: photo?.name ?? 'Photo',
						preview: photo ? URL.createObjectURL(photo.blob) : undefined,
						ref: { id, contentType: 'image/jpeg', bytes: 0, name: 'Photo', inline: true }
					};
				}),
				at: e.at,
				delivery: 'sending'
			});
		}
		this.#commit();
		// History waits for the stream's first frame, so every event after the page is either in it
		// or replayed above hello's head.
		let waited: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.#greeted,
			new Promise<void>((r) => (waited = setTimeout(r, HELLO_WAIT_MS)))
		]);
		clearTimeout(waited);
		if (!this.#disconnect) return;
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
		this.#draftTimer = null;
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
			historyGap: this.history === 'error' || this.olderError
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
				this.#retrying.delete(e.clientId);
				clearTimeout(this.#unacked.get(e.clientId));
				this.#unacked.delete(e.clientId);
				void this.#outbox.delete(e.clientId).catch(() => {});
				break;
			}
			case 'failed': {
				this.#failed.add(e.clientId);
				this.#retrying.delete(e.clientId);
				clearTimeout(this.#unacked.get(e.clientId));
				this.#unacked.delete(e.clientId);
				break;
			}
			case 'workspace':
				if (e.state === 'online') {
					this.#flushOutbox(true);
					if (this.history === 'error') this.retryHistory();
				}
				break;
			case 'resend':
				this.#flushOutbox(true);
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
		// Any first outcome (hello, a failed open, forbidden, hidden) ends start()'s wait.
		this.#greet();
		if (state === 'reconnecting') this.reconnectingSince ??= Date.now();
		else this.reconnectingSince = null;
		this.connection = state;
		if (state === 'open') this.#flushOutbox(false);
	}

	showToast(text: string) {
		this.toast = text;
		if (this.#toastTimer) clearTimeout(this.#toastTimer);
		this.#toastTimer = setTimeout(() => (this.toast = null), TOAST_MS);
	}

	// ── History ──

	async #loadHistory() {
		this.history = 'loading';
		this.olderError = false;
		this.#commit();
		const r = await this.#api.history({ limit: HISTORY_PAGE });
		// hello (and anything else let through the buffer) applies first, so its head filters the rest.
		if (this.#queue.length) this.#flush();
		const fx: Effect[] = [];
		if (r.ok) {
			fx.push(...mergeHistory(this.#s, r.page.items, { newest: true }));
			this.#before = r.page.before;
			this.hasOlder = r.page.before !== null;
			this.history = 'ready';
		} else {
			this.history = 'error';
		}
		for (const e of fx) this.#effect(e);
		const buffered = this.#buffer ?? [];
		this.#buffer = null;
		this.#queue.push(...buffered);
		this.#flush();
		this.#flushOutbox(this.workspace === 'online');
	}

	async loadOlder() {
		if (this.olderLoading || !this.#before) return;
		this.olderLoading = true;
		this.olderError = false;
		const r = await this.#api.history({ before: this.#before, limit: HISTORY_PAGE });
		this.olderLoading = false;
		if (!r.ok && r.reason === 'reset') {
			// The cursor went stale: start again from the newest page. The stream is fine, so the tray stays.
			const fx = restartHistory(this.#s);
			this.#commit();
			for (const e of fx) this.#effect(e);
			return;
		}
		if (!r.ok) {
			this.olderError = true;
			this.#commit();
			return;
		}
		const fx = mergeHistory(this.#s, r.page.items);
		this.#before = r.page.before;
		this.hasOlder = r.page.before !== null;
		this.#commit();
		for (const e of fx) this.#effect(e);
	}

	/** Retries the newest page if it failed, otherwise the last older page. */
	retryHistory() {
		if (this.history === 'error') {
			this.#buffer ??= [];
			void this.#loadHistory();
		} else if (this.olderError) {
			void this.loadOlder();
		}
	}

	// ── Sending ──

	setDraft(text: string) {
		this.draft = text;
		if (this.#draftTimer) clearTimeout(this.#draftTimer);
		this.#draftTimer = setTimeout(() => this.#saveDraft(), DRAFT_DEBOUNCE_MS);
	}

	/** Writes the draft text and its prepared photos now. */
	#saveDraft() {
		if (this.#draftTimer) clearTimeout(this.#draftTimer);
		this.#draftTimer = null;
		// Saving before the stored draft is read back would overwrite it with an empty one.
		if (!this.#draftRestored) return;
		const photos: DraftPhoto[] = this.photos.flatMap((p) =>
			p.blob
				? [
						{
							id: p.id,
							name: p.name,
							blob: p.blob,
							key: p.key,
							uploadId: p.uploadId,
							uploadedAt: p.uploadedAt,
							bytes: p.bytes
						}
					]
				: []
		);
		void this.#drafts
			.put({ id: 'main', text: this.draft, photos })
			.catch((err) => console.warn("Couldn't save the draft.", err));
	}

	#restorePhotos(saved: DraftPhoto[]) {
		const now = Date.now();
		const photos: Photo[] = saved.map((d) => {
			const fresh = !!d.uploadId && !!d.uploadedAt && now - d.uploadedAt < REUPLOAD_AFTER_MS;
			return {
				id: d.id,
				name: d.name,
				src: URL.createObjectURL(d.blob),
				blob: d.blob,
				file: d.blob,
				bytes: d.bytes,
				// A stale upload may already be collected, so it goes up again as a new row.
				key: fresh ? d.key : ulid(),
				...(fresh
					? { state: 'uploaded' as const, uploadId: d.uploadId, uploadedAt: d.uploadedAt }
					: { state: 'uploading' as const })
			};
		});
		this.photos = photos.slice(0, MESSAGE_UPLOADS_MAX);
		for (const p of this.photos) if (p.state !== 'uploaded') void this.#upload(p.id);
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
			photos: photos.map((p) => ({
				name: p.name,
				blob: p.blob!,
				uploadId: p.uploadId!,
				uploadedAt: p.uploadedAt!
			})),
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
					contentType: p.blob?.type || 'image/jpeg',
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
		this.draft = '';
		this.#saveDraft();
		this.#commit();
		this.#pending.set(entry.clientId, entry);
		await this.#outbox
			.put(entry)
			.catch((err) => console.warn("Couldn't save the message to the outbox.", err));
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
			await this.#refreshUploads(entry);
			const res = await this.#api.postMessage({
				clientId: id,
				text: entry.text,
				...(entry.uploadIds.length ? { uploadIds: entry.uploadIds } : {})
			});
			this.#retrying.delete(id);
			if (!this.#pending.has(id)) return;
			if (res.routed) {
				this.#effect({ type: 'delivered', clientId: id });
				setDelivery(this.#s, id, 'sent');
				return;
			}
			entry.posted = true;
			void this.#outbox.put(entry).catch(() => {});
			if (this.workspace === 'offline') setDelivery(this.#s, id, 'queued-agent');
			clearTimeout(this.#unacked.get(id));
			this.#unacked.set(
				id,
				setTimeout(() => {
					this.#unacked.delete(id);
					// Only a receipt settles an entry. While offline, the workspace's return re-sends it instead.
					const current = this.#pending.get(id);
					if (!current || this.#failed.has(id) || this.workspace !== 'online') return;
					void this.#deliver(current);
				}, UNACKED_MS)
			);
		} catch (err) {
			if (!this.#pending.has(id)) return;
			const missing = uploadMissingIds(err);
			if (missing) {
				this.#returnToComposer(entry, missing);
				return;
			}
			const e = err instanceof ChatHttpError ? err : new ChatHttpError(0, String(err));
			if (e.retryable) {
				this.#retrying.add(id);
				setDelivery(this.#s, id, e.status === 0 && !navigator.onLine ? 'queued' : 'queued-agent');
				this.#scheduleRetry();
			} else {
				this.#retrying.delete(id);
				this.#failed.add(id);
				setDelivery(this.#s, id, 'failed');
			}
		} finally {
			this.#inflight.delete(id);
			this.#commit();
		}
	}

	/**
	 * The bot refused the message because some of its photos are gone, and stored nothing. Resending would
	 * fail the same way, so the text and photos go back to the composer with the gone ones marked.
	 */
	#returnToComposer(entry: OutboxEntry, missing: string[]) {
		const id = entry.clientId;
		this.#pending.delete(id);
		this.#failed.delete(id);
		this.#retrying.delete(id);
		clearTimeout(this.#unacked.get(id));
		this.#unacked.delete(id);
		void this.#outbox.delete(id).catch(() => {});
		removeLocal(this.#s, id);
		const gone = new Set(missing);
		const restored: Photo[] = (entry.photos ?? []).map((p) => ({
			id: ulid(),
			name: p.name,
			src: URL.createObjectURL(p.blob),
			blob: p.blob,
			file: p.blob,
			key: ulid(),
			...(gone.has(p.uploadId)
				? { state: 'failed' as const, error: 'expired' as const }
				: { state: 'uploaded' as const, uploadId: p.uploadId, uploadedAt: p.uploadedAt })
		}));
		this.photos = [...restored, ...this.photos].slice(0, MESSAGE_UPLOADS_MAX);
		this.draft = this.draft ? `${entry.text}\n\n${this.draft}` : entry.text;
		this.#saveDraft();
		this.showToast('A photo in your message expired. Re-attach it and send again.');
	}

	/** Re-uploads photos old enough that the server may have collected them as orphans. */
	async #refreshUploads(entry: OutboxEntry) {
		// A posted message already references its uploads, and its resend must carry the same body.
		if (entry.posted) return;
		const stale = (entry.photos ?? []).filter((p) => Date.now() - p.uploadedAt > REUPLOAD_AFTER_MS);
		if (!stale.length) return;
		for (const p of stale) {
			const res = await this.#api.upload(p.blob, { name: p.name, clientId: ulid() }, () => {});
			p.uploadId = res.id;
			p.uploadedAt = Date.now();
		}
		entry.uploadIds = entry.photos!.map((p) => p.uploadId);
		await this.#outbox.put(entry).catch(() => {});
	}

	#scheduleRetry() {
		if (this.#retryTimer) return;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			this.#flushOutbox(false);
		}, RETRY_MS);
	}

	/** A 202'd entry already waits in the bot, so it resends only when the workspace returns or its resend failed. */
	#flushOutbox(resendPosted: boolean) {
		if (this.#buffer) return;
		for (const entry of this.#pending.values()) {
			const id = entry.clientId;
			if (this.#failed.has(id) || this.#inflight.has(id)) continue;
			if (entry.posted && !resendPosted && !this.#retrying.has(id)) continue;
			void this.#deliver(entry);
		}
	}

	/** Re-sends a failed message with the same client id, so the bot can dedupe it. */
	retry(messageId: string) {
		const clientId = this.#clientIdOf(messageId);
		const entry = clientId && this.#pending.get(clientId);
		if (entry) void this.#deliver(entry);
	}

	/** Deletes an unsent message. One the bot already holds is withdrawn there first, so it is never delivered. */
	async discard(messageId: string) {
		const clientId = this.#clientIdOf(messageId);
		const entry = clientId && this.#pending.get(clientId);
		if (!clientId || !entry) return;
		if (entry.posted) {
			let outcome: 'discarded' | 'routed' | 'unknown';
			try {
				outcome = await this.#api.discardMessage(clientId);
			} catch {
				this.showToast("Couldn't delete the message. Try again.");
				return;
			}
			if (!this.#pending.has(clientId)) return;
			if (outcome === 'routed') {
				setDelivery(this.#s, clientId, 'sent');
				this.#effect({ type: 'delivered', clientId });
				this.#commit();
				this.showToast('Already delivered');
				return;
			}
		}
		this.#pending.delete(clientId);
		this.#failed.delete(clientId);
		this.#retrying.delete(clientId);
		clearTimeout(this.#unacked.get(clientId));
		this.#unacked.delete(clientId);
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
				name: photoName(file.name),
				src: URL.createObjectURL(file),
				state: 'preparing',
				file,
				key: ulid()
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
		let blob = photo.blob;
		if (!blob) {
			try {
				this.#patchPhoto(id, { state: 'preparing', error: undefined, progress: undefined });
				blob = await preparePhoto(photo.file);
				this.#patchPhoto(id, { blob, name: photoName(photo.name, blob.type) });
				this.#saveDraft();
			} catch (err) {
				this.#patchPhoto(id, {
					state: 'failed',
					error: err instanceof PhotoError ? err.reason : 'type'
				});
				return;
			}
		}
		const current = this.photos.find((p) => p.id === id);
		if (!current) return;
		this.#patchPhoto(id, { state: 'uploading', progress: 0, error: undefined });
		try {
			const res = await this.#api.upload(
				blob,
				// The server returns the same upload for the same key and bytes, so a retry can't orphan one.
				{ name: current.name, clientId: current.key },
				(pct) => this.#patchPhoto(id, { progress: pct })
			);
			this.#patchPhoto(id, {
				state: 'uploaded',
				uploadId: res.id,
				uploadedAt: Date.now(),
				bytes: res.bytes,
				progress: 100
			});
			this.#saveDraft();
		} catch (err) {
			const status = err instanceof ChatHttpError ? err.status : 0;
			if (status === 507) this.quotaFull = true;
			this.#patchPhoto(id, { state: 'failed', error: uploadError(status) });
		}
	}

	removePhoto(id: string) {
		const photo = this.photos.find((p) => p.id === id);
		if (photo) URL.revokeObjectURL(photo.src);
		this.photos = this.photos.filter((p) => p.id !== id);
		if (!this.photos.some((p) => p.state === 'failed')) this.quotaFull = false;
		this.#saveDraft();
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
		} catch (err) {
			const status = err instanceof ChatHttpError ? err.status : 0;
			if (status === 404) {
				ask.state = 'history';
				this.showToast('That question is no longer waiting for an answer.');
			} else {
				markAsk(this.#s, askId, null);
				this.showToast(
					status === 403
						? NOT_OWNER
						: status === 0
							? "Couldn't send your answer. Check your connection and try again."
							: "Your answer didn't reach the agent. Try again."
				);
			}
		}
		this.#commit();
	}

	async decide(nonce: string, decision: 'approve' | 'deny') {
		this.#s.mine.add(`p:${nonce}`);
		this.trayPhase = 'submitting';
		try {
			const r = await this.#api.decide(nonce, { decision });
			if (r.status === 'expired') {
				dropApproval(this.#s, nonce, 'timeout');
				this.showToast('That approval had already expired.');
			}
		} catch (err) {
			this.#s.mine.delete(`p:${nonce}`);
			const status = err instanceof ChatHttpError ? err.status : 0;
			if (status === 404) {
				dropApproval(this.#s, nonce, 'cancelled');
				this.showToast('That approval is no longer waiting for a decision.');
			} else if (status === 403) {
				this.showToast(NOT_OWNER);
			} else if (status === 0) {
				this.showToast("Couldn't send your decision. Check your connection and try again.");
			} else {
				this.showToast("The agent couldn't take your decision. Try again.");
			}
		} finally {
			this.trayPhase = 'ready';
			this.#commit();
		}
	}

	// ── Presence ──

	setViewing(on: boolean) {
		this.viewing = on;
		if (on) this.#scheduleSeen();
	}

	#scheduleSeen() {
		if (!this.viewing || document.visibilityState !== 'visible') return;
		const seq = this.#s.cursor;
		if (seq === null || seq <= this.#seenSent) return;
		if (this.#seenTimer) clearTimeout(this.#seenTimer);
		this.#seenTimer = setTimeout(() => {
			this.#seenTimer = null;
			const now = this.#s.cursor;
			if (
				now === null ||
				now <= this.#seenSent ||
				!this.viewing ||
				document.visibilityState !== 'visible'
			)
				return;
			this.#seenSent = now;
			void this.#api.seen(now).catch(() => {
				this.#seenSent = 0;
			});
		}, SEEN_DEBOUNCE_MS);
	}
}
