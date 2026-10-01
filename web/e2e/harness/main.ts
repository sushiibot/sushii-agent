import './harness.css';
import { flushSync, mount, unmount } from 'svelte';
import { parseMarkdown } from '$lib/features/chat/render/markdown';
import { MarkdownStream } from '$lib/features/chat/render/streaming';
import Markdown from '$lib/features/chat/render/markdown.svelte';
import Harness from './Harness.svelte';
import { api } from './api.svelte';

const errors: string[] = [];
addEventListener('error', (e) => errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

let solo: ReturnType<typeof mount> | undefined;

Object.assign(window, {
	h: {
		api,
		errors,
		flushSync,
		/** The parser alone, so V8's stack limit applies to it directly. */
		parse(text: string) {
			const t = performance.now();
			try {
				const tree = parseMarkdown(text);
				return { ok: true, kinds: tree.map((n) => n.kind), ms: performance.now() - t };
			} catch (e) {
				return { ok: false, err: String(e), ms: performance.now() - t };
			}
		},
		/** Feeds `text` to a stream in `step`-char deltas, parsing after every one (no frame skipping),
		 *  and reports the parse cost of each. */
		streamCost(text: string, step: number) {
			const stream = new MarkdownStream();
			const ms: number[] = [];
			try {
				for (let n = step; n < text.length + step; n += step) {
					const t = performance.now();
					stream.update(text.slice(0, n), {});
					ms.push(performance.now() - t);
				}
				const t = performance.now();
				stream.finish(text, {});
				return { ok: true, ms, finishMs: performance.now() - t };
			} catch (e) {
				return { ok: false, err: String(e), ms, finishMs: 0 };
			}
		},
		/** Streams `text` into the mounted streaming reply, one delta per animation frame. */
		async streamInto(text: string, step: number) {
			api.stream = { text: '', streaming: true };
			const frames: number[] = [];
			let last = performance.now();
			for (let n = step; n < text.length + step; n += step) {
				api.stream.text = text.slice(0, n);
				await new Promise(requestAnimationFrame);
				const now = performance.now();
				frames.push(now - last);
				last = now;
			}
			api.stream.streaming = false;
			flushSync();
			return { frames };
		},
		/** Streams `text` on a timer, like a socket, and reports the gaps between frames meanwhile. */
		async streamTimed(text: string, step: number, everyMs: number) {
			api.stream = { text: '', streaming: true };
			await new Promise(requestAnimationFrame);
			const gaps: number[] = [];
			let last = performance.now();
			let alive = true;
			let sawPlain = false;
			const tick = () => {
				const now = performance.now();
				sawPlain ||= !!document.querySelector('#streamed p.whitespace-pre-wrap');
				gaps.push(now - last);
				last = now;
				if (alive) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			await new Promise<void>((done) => {
				let n = 0;
				const next = () => {
					n += step;
					api.stream.text = text.slice(0, n);
					if (n >= text.length) done();
					else setTimeout(next, everyMs);
				};
				next();
			});
			await new Promise((r) => setTimeout(r, 300));
			alive = false;
			api.stream.streaming = false;
			flushSync();
			return { gaps, sawPlain };
		},
		/** Mounts a reply mid-stream at `at` chars, as after a reload, then streams the rest on a fake
		 *  clock: deltas `deltaMs` apart, each in its own flush, a frame every `perFrame` deltas arriving
		 *  `drawMs` late, and every parse costing `parseMs`. Counts parses and rendered-frame reports, so the result depends only
		 *  on the throttle's logic, not on how fast the machine is. */
		lateMount(
			text: string,
			at: number,
			step: number,
			perFrame: number,
			deltaMs: number,
			parseMs: number,
			drawMs = 0
		) {
			const counts = { updates: 0, rendered: 0, deltas: 0, frames: 0, sawPlain: false };
			const target = document.getElementById('solo')!;
			const proto = MarkdownStream.prototype;
			const { update, rendered } = proto;
			const realRaf = window.requestAnimationFrame;
			const realCaf = window.cancelAnimationFrame;
			let clock = performance.now();
			let parsing = false;
			const frames = new Map<number, FrameRequestCallback>();
			let nextId = 0;
			// Inside an update every clock read advances it, so the stream sees each parse take `parseMs`.
			Object.defineProperty(performance, 'now', {
				configurable: true,
				value: () => {
					const t = clock;
					if (parsing) clock += parseMs;
					return t;
				}
			});
			window.requestAnimationFrame = (cb) => {
				frames.set(++nextId, cb);
				return nextId;
			};
			window.cancelAnimationFrame = (id) => void frames.delete(id);
			let last: unknown;
			proto.update = function (...args) {
				parsing = true;
				try {
					const tree = update.apply(this, args);
					// An update with unchanged text returns the same array: a memo hit, not a parse.
					if (tree !== last) counts.updates++;
					last = tree;
					return tree;
				} finally {
					parsing = false;
				}
			};
			proto.rendered = function (...args) {
				counts.rendered++;
				return rendered.apply(this, args);
			};
			try {
				if (solo) unmount(solo);
				target.replaceChildren();
				api.late = { text: text.slice(0, at), streaming: true };
				solo = mount(Markdown, {
					target,
					props: {
						get text() {
							return api.late.text;
						},
						get streaming() {
							return api.late.streaming;
						}
					}
				});
				flushSync();
				for (let n = at + step; n < text.length + step; n += step) {
					clock += deltaMs;
					counts.deltas++;
					api.late.text = text.slice(0, n);
					flushSync();
					if (counts.deltas % perFrame) continue;
					counts.frames++;
					clock += drawMs;
					const due = [...frames.values()];
					frames.clear();
					for (const cb of due) cb(clock);
					flushSync();
					counts.sawPlain ||= !!target.querySelector('p.whitespace-pre-wrap');
				}
			} finally {
				delete (performance as { now?: unknown }).now;
				window.requestAnimationFrame = realRaf;
				window.cancelAnimationFrame = realCaf;
				proto.update = update;
				proto.rendered = rendered;
			}
			return counts;
		},
		/** Mounts one reply on its own and reports whether mounting threw. */
		render(text: string, props: Record<string, unknown> = {}) {
			const target = document.getElementById('solo')!;
			if (solo) unmount(solo);
			target.replaceChildren();
			try {
				solo = mount(Markdown, { target, props: { text, ...props } });
				flushSync();
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e) };
			}
		},
		/** Runs a list mutation and flush, capturing a throw instead of losing the page. */
		step(fn: () => void) {
			try {
				fn();
				flushSync();
			} catch (e) {
				errors.push(String(e));
			}
		}
	}
});

mount(Harness, { target: document.getElementById('app')! });
Object.assign(window, { ready: true });
