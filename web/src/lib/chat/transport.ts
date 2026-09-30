import type { ChatEnvelope } from './events';
import { SseParser, toEnvelope } from './sse';

export type TransportState = 'open' | 'reconnecting' | 'closed' | 'forbidden';

export interface ChatTransport {
	connect(
		after: number | null,
		on: (ev: ChatEnvelope) => void,
		onState: (s: TransportState) => void
	): () => void;
}

export interface FetchSseOptions {
	url?: string;
	fetch?: typeof fetch;
	/** Three missed 15s heartbeats. */
	idleMs?: number;
	/** A stream that ends sooner than this counts as a failure, so a broken proxy can't hot-loop. */
	minHealthyMs?: number;
	backoff?: (attempt: number) => number;
}

const defaultBackoff = (attempt: number) =>
	Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() * 0.5);

/**
 * SSE over fetch, so the stream can send Fetch Metadata and be read incrementally. Resumes from the
 * last durable seq, closes while the page is hidden and reopens when it's visible again.
 */
export function fetchSse(opts: FetchSseOptions = {}): ChatTransport {
	const url = opts.url ?? '/api/chat/stream';
	const idleMs = opts.idleMs ?? 45_000;
	const minHealthyMs = opts.minHealthyMs ?? 5_000;
	const backoff = opts.backoff ?? defaultBackoff;

	return {
		connect(initialAfter, on, onState) {
			let after = initialAfter;
			let stopped = false;
			let attempt = 0;
			let ctrl: AbortController | null = null;
			let wait: ReturnType<typeof setTimeout> | null = null;
			let wake: (() => void) | null = null;
			let state: TransportState | null = null;
			const set = (s: TransportState) => {
				if (state === s) return;
				state = s;
				onState(s);
			};

			const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

			function sleep(ms: number) {
				return new Promise<void>((resolve) => {
					wake = () => {
						if (wait) clearTimeout(wait);
						wait = null;
						wake = null;
						resolve();
					};
					wait = setTimeout(() => wake?.(), ms);
				});
			}

			async function once(): Promise<'ok' | 'fail' | 'forbidden' | 'aborted'> {
				ctrl = new AbortController();
				const signal = ctrl.signal;
				let idle: ReturnType<typeof setTimeout> | null = null;
				const kick = () => {
					if (idle) clearTimeout(idle);
					idle = setTimeout(() => ctrl?.abort(new DOMException('idle', 'TimeoutError')), idleMs);
				};
				const opened = Date.now();
				try {
					kick();
					const q = after === null ? '' : `?after=${after}`;
					const res = await (opts.fetch ?? fetch)(url + q, {
						headers: { accept: 'text/event-stream' },
						cache: 'no-store',
						credentials: 'same-origin',
						signal
					});
					if (res.status === 403) return 'forbidden';
					if (!res.ok || !res.body) return 'fail';
					const parser = new SseParser();
					const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						kick();
						for (const frame of parser.push(value)) {
							const ev = toEnvelope(frame);
							if (!ev) continue;
							if (ev.type === 'hello' || ev.type === 'reset') {
								if (ev.type === 'reset' || after === null) after = ev.data.headSeq;
								attempt = 0;
								set('open');
							} else if (ev.seq !== undefined) {
								after = ev.seq;
							}
							on(ev);
						}
					}
					return Date.now() - opened < minHealthyMs ? 'fail' : 'ok';
				} catch {
					return signal.aborted && stopped ? 'aborted' : 'fail';
				} finally {
					if (idle) clearTimeout(idle);
				}
			}

			async function run() {
				while (!stopped) {
					if (hidden()) {
						set('closed');
						await sleep(2 ** 31 - 1);
						continue;
					}
					const r = await once();
					if (stopped) return;
					if (r === 'forbidden') {
						set('forbidden');
						await sleep(2 ** 31 - 1);
						continue;
					}
					if (hidden()) continue;
					if (r === 'ok') {
						attempt = 0;
						continue;
					}
					set('reconnecting');
					await sleep(backoff(attempt++));
				}
			}

			const onVisibility = () => {
				if (hidden()) {
					ctrl?.abort();
				} else {
					wake?.();
				}
			};
			const onOnline = () => {
				attempt = 0;
				wake?.();
			};
			if (typeof document !== 'undefined') {
				document.addEventListener('visibilitychange', onVisibility);
				addEventListener('online', onOnline);
			}
			void run();

			return () => {
				stopped = true;
				ctrl?.abort();
				wake?.();
				if (typeof document !== 'undefined') {
					document.removeEventListener('visibilitychange', onVisibility);
					removeEventListener('online', onOnline);
				}
			};
		}
	};
}
