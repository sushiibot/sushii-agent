import type { ChatEnvelope, ChatEventType, WorkspaceState } from './events';
import { fetchSse, type ChatTransport, type TransportState } from './transport';

/** Widens when conversations other than Main reach the wire. */
export type ConversationId = 'main';

export interface HubFilter {
	conversation?: ConversationId;
	types?: readonly ChatEventType[];
}

export interface Hub {
	readonly connection: TransportState | 'connecting';
	readonly reconnectingSince: number | null;
	readonly workspace: WorkspaceState | null;
	readonly headSeq: number | null;
	/** Opens the stream; later calls do nothing. */
	start(): void;
	stop(): void;
	/**
	 * At most one call per animation frame, events in arrival order. `hello`, `reset` and
	 * `workspace` reach every subscriber whatever the filter; other global events (approvals) reach
	 * every subscriber whose `types`, if set, include them.
	 */
	subscribe(filter: HubFilter, onBatch: (batch: readonly ChatEnvelope[]) => void): () => void;
	/** Called with each transport state change, and at once with the current one if known. */
	onState(fn: (state: TransportState) => void): () => void;
	/** Delivers queued events now instead of on the next frame. */
	flush(): void;
}

const LIFECYCLE = new Set<ChatEventType>(['hello', 'reset', 'workspace']);
const GLOBAL = new Set<ChatEventType>([...LIFECYCLE, 'approval', 'approval_resolved']);

/** The conversation an event belongs to, or null for connection-wide events. */
export function conversationOf(ev: ChatEnvelope): ConversationId | null {
	return GLOBAL.has(ev.type) ? null : 'main';
}

function matches(filter: HubFilter, ev: ChatEnvelope): boolean {
	if (LIFECYCLE.has(ev.type)) return true;
	if (filter.types && !filter.types.includes(ev.type)) return false;
	const conversation = conversationOf(ev);
	return !filter.conversation || conversation === null || conversation === filter.conversation;
}

class RealtimeHub implements Hub {
	connection = $state<TransportState | 'connecting'>('connecting');
	reconnectingSince = $state<number | null>(null);
	workspace = $state<WorkspaceState | null>(null);
	headSeq = $state<number | null>(null);

	#transport: ChatTransport | undefined;
	#makeTransport: () => ChatTransport;
	#disconnect: (() => void) | null = null;
	#subs = new Set<{ filter: HubFilter; onBatch: (batch: readonly ChatEnvelope[]) => void }>();
	#watchers = new Set<(state: TransportState) => void>();
	#state: TransportState | null = null;
	#queue: ChatEnvelope[] = [];
	#frame: { cancel(): void } | null = null;

	constructor(makeTransport: () => ChatTransport) {
		this.#makeTransport = makeTransport;
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
	}

	subscribe(filter: HubFilter, onBatch: (batch: readonly ChatEnvelope[]) => void) {
		const sub = { filter, onBatch };
		this.#subs.add(sub);
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
			const batch = queue.filter((ev) => matches(sub.filter, ev));
			if (batch.length) sub.onBatch(batch);
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
