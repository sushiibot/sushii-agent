import { HttpError } from '$lib/core/http';
import type { ChatEnvelope } from '$lib/core/realtime/events';
import { hub as appHub, type Hub } from '$lib/core/realtime/hub.svelte';
import { Remote } from '$lib/core/remote.svelte';
import { chatApi, type ChatApi } from '$lib/features/chat';
import { httpHomeApi, type HomeApi } from './api';
import { applyLive, emptyLive, homeItems, type LiveState, type LocalState } from './needs-you';
import type { HomeData, HomeGroups } from './types';

export interface HomeDeps {
	hub?: Hub;
	api?: HomeApi;
	chat?: () => ChatApi;
}

type Result = { ok: boolean; text: string };

/** Live events that change Home's server part; a burst of them refetches once. */
const REFETCH_ON = new Set(['run', 'alert', 'alert_cleared', 'inbox']);
const REFETCH_DEBOUNCE_MS = 1000;
/** How long Undo stays offered after marking an item done. */
export const UNDO_MS = 6000;

function failureText(err: unknown, what: 'decision' | 'answer'): string {
	const status = err instanceof HttpError ? err.status : 0;
	if (status === 403) return "This device isn't signed in as the owner.";
	if (status === 0) return `Couldn't send your ${what}. Check your connection and try again.`;
	return `The agent couldn't take your ${what}. Try again.`;
}

/** Home: what is waiting on you, what failed, what is running and what is ready to look at. */
export class NeedsYouStore {
	live = $state.raw<LiveState>(emptyLive());
	/** null: the bot has Home turned off, so only the stream's part shows. */
	data: Remote<HomeData | null>;
	local = $state.raw<LocalState>({ dismissed: [], opened: [], asks: {} });
	/** Approvals with a decision in flight from Home. */
	submitting = $state.raw<readonly string[]>([]);
	/** What happened to the last thing done from Home, by item id. */
	results = $state.raw<Readonly<Record<string, Result>>>({});
	/** The item last marked done, while Undo is offered. */
	undoable = $state.raw<{ id: string; label: string } | null>(null);

	groups: HomeGroups = $derived.by(() => homeItems(this.live, this.data.data, this.local));
	waitingCount = $derived(this.groups.waiting.length);
	/** What the menu badge counts: what waits on you and what failed. */
	needsYouCount = $derived(this.groups.waiting.length + this.groups.failed.length);
	unreadCount = $derived(this.groups.review.filter((i) => 'read' in i && !i.read).length);

	#hub: Hub;
	#api: HomeApi;
	#chat: () => ChatApi;
	#stop: (() => void) | null = null;
	#greeted = false;
	#refetchTimer: ReturnType<typeof setTimeout> | null = null;
	/** Loads started so far; the server part of a load reflects every change acked before it began. */
	#loads = 0;
	/** Local hides (dismissed, opened, cleared) by item id, with the load count when the bot had them. */
	#acked = new Map<string, number>();
	#undoTimer: ReturnType<typeof setTimeout> | null = null;
	/** Done requests in flight, so an Undo lands after its done. */
	#doing = new Map<string, Promise<boolean>>();

	constructor(deps: HomeDeps = {}) {
		this.#hub = deps.hub ?? appHub;
		this.#api = deps.api ?? httpHomeApi;
		this.#chat = deps.chat ?? chatApi;
		this.data = new Remote(() => this.#load(), { refetchOnFocus: true });
	}

	async #load(): Promise<HomeData | null> {
		const load = ++this.#loads;
		const data = await this.#api.load();
		this.#settle(load);
		return data;
	}

	/** Drops local hides the bot's answer to a load that began after them already reflects. */
	#settle(load: number) {
		const done = [...this.#acked].filter(([, at]) => at < load).map(([id]) => id);
		if (!done.length) return;
		for (const id of done) this.#acked.delete(id);
		const keep = (id: string) => !done.includes(id);
		this.local = {
			...this.local,
			dismissed: this.local.dismissed.filter(keep),
			opened: this.local.opened.filter(keep)
		};
	}

	#hide(id: string, list: 'dismissed' | 'opened') {
		if (this.local[list].includes(id)) return;
		this.local = { ...this.local, [list]: [...this.local[list], id] };
	}

	#unhide(id: string) {
		this.#acked.delete(id);
		this.local = { ...this.local, dismissed: this.local.dismissed.filter((d) => d !== id) };
	}

	/** Refetches the server part soon, once per burst of events, if it was ever loaded. */
	#scheduleRefetch() {
		if (this.#refetchTimer) clearTimeout(this.#refetchTimer);
		this.#refetchTimer = setTimeout(() => {
			this.#refetchTimer = null;
			if (this.data.status !== 'idle') void this.data.refetch();
		}, REFETCH_DEBOUNCE_MS);
	}

	#onEvent(ev: ChatEnvelope) {
		if (ev.type === 'hello' || ev.type === 'reset') {
			// The first greeting comes with the first load; a later one means the stream was down.
			if (this.#greeted) this.#scheduleRefetch();
			this.#greeted = true;
			return;
		}
		if (ev.type === 'alert_cleared') {
			this.#hide(ev.data.id, 'dismissed');
			this.#acked.set(ev.data.id, this.#loads);
		} else if (ev.type === 'alert' && ev.data.alert.kind !== 'recovered') {
			// A new failure reopens a job dismissed or cleared here before.
			this.#unhide(`job:${ev.data.alert.job}`);
		}
		if (REFETCH_ON.has(ev.type)) this.#scheduleRefetch();
	}

	/** Listens to the stream for the app's life; the tab badge needs it on every screen. */
	start() {
		if (this.#stop) return;
		this.#stop = this.#hub.subscribe(
			{
				conversation: 'main',
				types: [
					'ask',
					'ask_resolved',
					'snapshot',
					'tool',
					'turn_final',
					'alert',
					'alert_cleared',
					'run',
					'inbox'
				],
				globals: ['approval', 'approval_resolved']
			},
			(batch) => {
				let next = this.live;
				for (const ev of batch) {
					next = applyLive(next, ev);
					this.#onEvent(ev);
				}
				if (next !== this.live) this.live = next;
			}
		);
		this.#hub.start();
		// The menu badge counts what waits on every screen, and the app opens on the chat, so the server
		// part loads from the start and refreshes app-wide.
		void this.data.ensure();
		this.data.watch();
	}

	/** Loads the server part, or refreshes it when Home comes back on screen. */
	open() {
		this.start();
		if (this.data.status === 'ready' || this.data.status === 'error') void this.data.refetch();
		else void this.data.ensure();
	}

	#result(id: string, result: Result | null) {
		const next = { ...this.results };
		if (result) next[id] = result;
		else delete next[id];
		this.results = next;
	}

	async decide(nonce: string, decision: 'approve' | 'deny') {
		const id = `approval:${nonce}`;
		if (this.submitting.includes(nonce)) return;
		this.submitting = [...this.submitting, nonce];
		this.#result(id, null);
		try {
			const r = await this.#chat().decide(nonce, { decision });
			this.#result(
				id,
				r.status === 'expired'
					? { ok: false, text: 'That approval had already expired, so it did not run.' }
					: decision === 'approve'
						? { ok: true, text: 'Approved. The agent carries on.' }
						: { ok: true, text: "Denied. The agent won't run it." }
			);
		} catch (err) {
			const gone = err instanceof HttpError && err.status === 404;
			this.#result(id, {
				ok: false,
				text: gone
					? 'That approval is no longer waiting for a decision.'
					: failureText(err, 'decision')
			});
		} finally {
			this.submitting = this.submitting.filter((n) => n !== nonce);
		}
	}

	#ask(askId: string, state: LocalState['asks'][string] | null) {
		const asks = { ...this.local.asks };
		if (state) asks[askId] = state;
		else delete asks[askId];
		this.local = { ...this.local, asks };
	}

	async answer(askId: string, answer: string, index?: number) {
		const id = `ask:${askId}`;
		this.#result(id, null);
		this.#ask(askId, { state: 'answering', answer });
		try {
			const r = await this.#chat().answerAsk(
				askId,
				index === undefined ? { text: answer } : { index, label: answer }
			);
			if (r.status === 'failed') throw new HttpError(502, 'failed');
			if (r.status === 'inactive') {
				this.#ask(askId, null);
				this.#result(id, { ok: false, text: 'That question is no longer waiting for an answer.' });
				return;
			}
			this.#ask(askId, { state: 'answered', answer });
			this.#result(id, { ok: true, text: 'Sent. The agent has your answer.' });
		} catch (err) {
			this.#ask(askId, null);
			const gone = err instanceof HttpError && err.status === 404;
			this.#result(id, {
				ok: false,
				text: gone
					? 'That question is no longer waiting for an answer.'
					: failureText(err, 'answer')
			});
		}
	}

	async dismiss(id: string) {
		this.#acked.delete(id);
		this.#hide(id, 'dismissed');
		try {
			await this.#api.dismiss(id);
			this.#acked.set(id, this.#loads);
		} catch {
			this.#unhide(id);
			this.#result(id, { ok: false, text: "Couldn't dismiss it. Try again." });
		}
	}

	/** Opening a finished run marks it read. */
	markOpened(runId: string) {
		this.markRead(`run:${runId}`);
	}

	/** Opening an inbox item marks it read on every device; it stays until marked done. */
	markRead(id: string) {
		// With Home off on the bot there is no inbox.
		if (this.data.status === 'ready' && this.data.data === null) return;
		if (this.local.opened.includes(id)) return;
		if (this.groups.review.some((i) => i.id === id && 'read' in i && i.read)) return;
		this.#hide(id, 'opened');
		// The local mark already shows it read here; a lost POST only means another device shows it unread.
		this.#api.opened(id).then(
			() => this.#acked.set(id, this.#loads),
			() => {}
		);
	}

	/** Takes an inbox item off Home on every device, with Undo offered for a while. */
	done(id: string, label: string) {
		this.#acked.delete(id);
		this.#hide(id, 'dismissed');
		this.#offerUndo({ id, label });
		const req = this.#api.dismiss(id).then(
			() => {
				this.#acked.set(id, this.#loads);
				return true;
			},
			() => {
				this.#unhide(id);
				if (this.undoable?.id === id) this.#offerUndo(null);
				this.#result(id, { ok: false, text: "Couldn't mark it done. Try again." });
				return false;
			}
		);
		this.#doing.set(id, req);
		void req.finally(() => {
			if (this.#doing.get(id) === req) this.#doing.delete(id);
		});
	}

	/** Brings back the item last marked done. */
	async undo() {
		const last = this.undoable;
		if (!last) return;
		this.#offerUndo(null);
		this.#unhide(last.id);
		if ((await this.#doing.get(last.id)) === false) return;
		try {
			await this.#api.restore(last.id);
		} catch {
			this.#hide(last.id, 'dismissed');
			this.#result(last.id, { ok: false, text: "Couldn't bring it back. Try again." });
		}
		this.#scheduleRefetch();
	}

	dismissUndo() {
		this.#offerUndo(null);
	}

	#offerUndo(next: { id: string; label: string } | null) {
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		this.#undoTimer = next ? setTimeout(() => (this.undoable = null), UNDO_MS) : null;
		this.undoable = next;
	}

	clearResult(id: string) {
		this.#result(id, null);
	}
}

let store: NeedsYouStore | null = null;
let configured: HomeDeps = {};

/** Swaps in other dependencies, for tests; call before the first store. */
export function configureHome(deps: HomeDeps) {
	configured = deps;
}

export function needsYou(): NeedsYouStore {
	return (store ??= new NeedsYouStore(configured));
}
