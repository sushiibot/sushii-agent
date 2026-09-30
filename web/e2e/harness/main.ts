import './harness.css';
import { flushSync, mount, unmount } from 'svelte';
import { parseMarkdown } from '$lib/features/chat/render/markdown';
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
