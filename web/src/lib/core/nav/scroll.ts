import { beforeNavigate } from '$app/navigation';
import { onMount } from 'svelte';

const saved = new Map<string, number>();

/**
 * Keeps a screen's inner scroller position across leaving and coming back, which Kit's own
 * restoration misses because it only tracks the window. Only a non-zero offset is restored, so a
 * column-reverse chat opened fresh still lands on its newest message.
 */
export function keepScroll(key: string, scroller: () => HTMLElement | null) {
	beforeNavigate(() => {
		const el = scroller();
		if (el) saved.set(key, el.scrollTop);
	});
	onMount(() => {
		const top = saved.get(key);
		const el = scroller();
		if (el && top) el.scrollTop = top;
	});
}
