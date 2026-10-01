// An in-memory stream for dev mode and tests: it opens with `hello` like the gateway, then carries
// whatever the caller emits, numbering durable events the way the server's `id:` does.
import type { ChatEnvelope, ChatEventMap, ChatEventType, WorkspaceState } from './events';
import type { ChatTransport, TransportState } from './transport';

export interface FakeTransport {
	transport: ChatTransport;
	/** The last durable seq handed out. */
	readonly seq: number;
	workspace: WorkspaceState;
	emit<T extends ChatEventType>(type: T, data: ChatEventMap[T], durable?: boolean): void;
	/** Reports a transport state to every open connection. */
	setState(state: TransportState): void;
}

export function fakeTransport(opts: { seq?: number; helloDelayMs?: number } = {}): FakeTransport {
	let seq = opts.seq ?? 0;
	const helloDelayMs = opts.helloDelayMs ?? 0;
	const sinks = new Set<{ on: (ev: ChatEnvelope) => void; onState: (s: TransportState) => void }>();

	const fake: FakeTransport = {
		get seq() {
			return seq;
		},
		workspace: 'online',
		emit(type, data, durable = true) {
			const ev = { type, data, ...(durable ? { seq: ++seq } : {}) } as ChatEnvelope;
			for (const s of sinks) s.on(ev);
		},
		setState(state) {
			for (const s of sinks) s.onState(state);
		},
		transport: {
			connect(_after, on, onState) {
				const sink = { on, onState };
				sinks.add(sink);
				const t = setTimeout(() => {
					onState('open');
					on({
						type: 'hello',
						data: {
							headSeq: seq,
							workspace: fake.workspace,
							openTurns: [],
							pending: { approvals: [], asks: [] }
						}
					});
				}, helloDelayMs);
				return () => {
					clearTimeout(t);
					sinks.delete(sink);
				};
			}
		}
	};
	return fake;
}
