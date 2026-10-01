import type { ChatEnvelope, ChatEventType, WorkspaceState } from './events';
import { fetchSse, type ChatTransport, type TransportState } from './transport';

/** Widens when conversations other than Main reach the wire. */
export type ConversationId = 'main';

export type GlobalEventType = 'approval' | 'approval_resolved';

export interface HubFilter {
	conversation?: ConversationId;
	types?: readonly ChatEventType[];
	/**
	 * Connection-wide events this subscriber also wants, such as approvals for the store that
	 * shows the tray. Without `approval` here, `hello`/`reset` arrive with no pending approvals.
	 */
	globals?: readonly GlobalEventType[];
}

export interface Hub {
	readonly connection: TransportState | 'connecting';
	readonly reconnectingSince: number | null;
	readonly workspace: WorkspaceState | null;
	readonly headSeq: number | null;
	/** Opens the stream; later calls do nothing. */
	start(): void;
	/** Closes the stream and forgets everything it heard. */
	stop(): void;
	/**
	 * At most one call per animation frame, events in arrival order. `hello`, `reset` and
	 * `workspace` reach every subscriber whatever the filter; approvals only those that opt in
	 * through `globals`. A subscriber that joins after `hello` first gets it replayed, with what
	 * has changed since (resolved approvals and asks, ended turns, the workspace state).
	 */
	subscribe(filter: HubFilter, onBatch: (batch: readonly ChatEnvelope[]) => void): () => void;
	/** Called with each transport state change, and at once with the current one if known. */
	onState(fn: (state: TransportState) => void): () => void;
	/**
	 * Delivers queued events now instead of on the next frame, to every current subscriber,
	 * including ones that joined after the events arrived.
	 */
	flush(): void;
	/** Uses this transport instead of the real stream; only before `start`. */
	useTransport(transport: ChatTransport): void;
}

const LIFECYCLE = new Set<ChatEventType>(['hello', 'reset', 'workspace']);
const GLOBALS = new Set<ChatEventType>(['approval', 'approval_resolved']);

/** The conversation an event belongs to, or null for connection-wide events. */
export function conversationOf(ev: ChatEnvelope): ConversationId | null {
	return LIFECYCLE.has(ev.type) || GLOBALS.has(ev.type) ? null : 'main';
}

function matches(filter: HubFilter, ev: ChatEnvelope): boolean {
	if (LIFECYCLE.has(ev.type)) return true;
	if (GLOBALS.has(ev.type)) return !!filter.globals?.includes(ev.type as GlobalEventType);
	if (filter.types && !filter.types.includes(ev.type)) return false;
	return !filter.conversation || conversationOf(ev) === filter.conversation;
}

/** `hello`/`reset` as a subscriber sees it: pending approvals only for those that opted in. */
function forSubscriber(filter: HubFilter, ev: ChatEnvelope): ChatEnvelope {
	if (ev.type !== 'hello' && ev.type !== 'reset') return ev;
	if (filter.globals?.includes('approval')) return ev;
	return {
		...ev,
		data: { ...ev.data, pending: { ...ev.data.pending, approvals: [] } }
	} as ChatEnvelope;
}

type Sub = { filter: HubFilter; onBatch: (batch: readonly ChatEnvelope[]) => void };

class RealtimeHub implements Hub {
	connection = $state<TransportState | 'connecting'>('connecting');
	reconnectingSince = $state<number | null>(null);
	workspace = $state<WorkspaceState | null>(null);
	headSeq = $state<number | null>(null);

	#transport: ChatTransport | undefined;
	#makeTransport: () => ChatTransport;
	#disconnect: (() => void) | null = null;
	#subs = new Set<Sub>();
	#watchers = new Set<(state: TransportState) => void>();
	#state: TransportState | null = null;
	#queue: ChatEnvelope[] = [];
	#frame: { cancel(): void } | null = null;
	/** The last `hello`/`reset` and what has changed since, for subscribers that join later. */
	#snapshot: ChatEnvelope[] = [];

	constructor(makeTransport: () => ChatTransport) {
		this.#makeTransport = makeTransport;
	}

	useTransport(transport: ChatTransport) {
		if (this.#disconnect) throw new Error('The stream is already open.');
		this.#transport = transport;
	}

	start() {
		if (this.#disconnect) return;
		this.#transport ??= this.#makeTransport();
		this.#disconnect = this.#transport.connect(
			null,
			(ev) => this.#receive(ev),
			(state) => this.#onState(state)
		);
	}

	stop() {
		this.#disconnect?.();
		this.#disconnect = null;
		this.#frame?.cancel();
		this.#frame = null;
		this.#queue = [];
		this.#snapshot = [];
		this.#state = null;
		this.connection = 'connecting';
		this.reconnectingSince = null;
		this.workspace = null;
		this.headSeq = null;
	}

	subscribe(filter: HubFilter, onBatch: (batch: readonly ChatEnvelope[]) => void) {
		const sub: Sub = { filter, onBatch };
		this.#subs.add(sub);
		const replay = this.#snapshot
			.filter((ev) => matches(filter, ev))
			.map((ev) => forSubscriber(filter, ev));
		if (replay.length) {
			// Before the next frame, so the replay always lands ahead of anything live.
			queueMicrotask(() => {
				if (this.#subs.has(sub)) onBatch(replay);
			});
		}
		return () => void this.#subs.delete(sub);
	}

	onState(fn: (state: TransportState) => void) {
		this.#watchers.add(fn);
		if (this.#state) fn(this.#state);
		return () => void this.#watchers.delete(fn);
	}

	flush() {
		this.#frame?.cancel();
		this.#frame = null;
		const queue = this.#queue.splice(0);
		if (!queue.length) return;
		for (const sub of [...this.#subs]) {
			const batch = queue
				.filter((ev) => matches(sub.filter, ev))
				.map((ev) => forSubscriber(sub.filter, ev));
			if (batch.length) sub.onBatch(batch);
		}
	}

	#remember(ev: ChatEnvelope) {
		if (ev.type === 'hello' || ev.type === 'reset') {
			this.#snapshot = [ev];
			return;
		}
		const snap = this.#snapshot;
		if (!snap.length) return;
		const drop = (pred: (e: ChatEnvelope) => boolean) => {
			const i = snap.findIndex(pred);
			if (i > 0) snap.splice(i, 1);
			return i > 0;
		};
		switch (ev.type) {
			case 'workspace':
				drop((e) => e.type === 'workspace');
				snap.push(ev);
				break;
			case 'approval':
			case 'ask':
				snap.push(ev);
				break;
			case 'approval_resolved':
				// A request that came and went after the snapshot leaves no trace in it.
				if (!drop((e) => e.type === 'approval' && e.data.nonce === ev.data.nonce)) snap.push(ev);
				break;
			case 'ask_resolved':
				if (!drop((e) => e.type === 'ask' && e.data.askId === ev.data.askId)) snap.push(ev);
				break;
			case 'turn_final': {
				const base = snap[0];
				if (base.type === 'hello' && base.data.openTurns.some((t) => t.turnId === ev.data.turnId)) {
					snap.push(ev);
				}
				break;
			}
		}
	}

	#receive(ev: ChatEnvelope) {
		if (ev.type === 'hello' || ev.type === 'reset') {
			this.headSeq = ev.data.headSeq;
			this.workspace = ev.data.workspace;
		} else if (ev.type === 'workspace') {
			this.workspace = ev.data.state;
		} else if (ev.seq !== undefined) {
			this.headSeq = ev.seq;
		}
		this.#remember(ev);
		this.#queue.push(ev);
		if (this.#frame) return;
		const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
		if (typeof requestAnimationFrame === 'function' && visible) {
			const id = requestAnimationFrame(() => this.flush());
			this.#frame = { cancel: () => cancelAnimationFrame(id) };
		} else {
			const id = setTimeout(() => this.flush(), 16);
			this.#frame = { cancel: () => clearTimeout(id) };
		}
	}

	#onState(state: TransportState) {
		if (state === 'reconnecting') this.reconnectingSince ??= Date.now();
		else this.reconnectingSince = null;
		this.connection = state;
		this.#state = state;
		for (const fn of [...this.#watchers]) fn(state);
	}
}

export function createHub(deps: { transport?: ChatTransport } = {}): Hub {
	return new RealtimeHub(() => deps.transport ?? fetchSse());
}

/** The app's one stream. */
export const hub: Hub = createHub();
