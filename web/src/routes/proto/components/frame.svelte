<script lang="ts">
	import { getContext } from 'svelte';
	import type { Frame } from '../flows';
	import { frameFor } from '../flows';

	let { frame, width }: { frame: Frame; width: number } = $props();
	const go = getContext<(id: string) => void>('proto-go');

	const w = $derived(frame.desktop ? 1280 : width);
	const h = $derived(frame.desktop ? 800 : 844);
	const text = (el: Element) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

	// Screens stay free of prototype wiring: jumps come from button text or the app's own hrefs.
	function onclickcapture(e: MouseEvent) {
		const el = (e.target as Element).closest('button, a');
		if (!el) return;
		const label = text(el);
		const hit = Object.entries(frame.hits ?? {}).find(([h]) => label.startsWith(h))?.[1];
		const href = el.getAttribute('href');
		const target = hit ?? (href?.startsWith('/') ? frameFor(href) : undefined);
		if (href) e.preventDefault();
		if (!target) return;
		e.stopPropagation();
		go(target);
	}
</script>

<figure id={frame.id} class="flex shrink-0 scroll-m-24 flex-col gap-2" style="width: {w}px">
	<figcaption class="flex items-baseline gap-2 px-1">
		<a
			href="#{frame.id}"
			onclick={(e) => {
				e.preventDefault();
				go(frame.id);
			}}
			class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground/80 tabular-nums hover:text-brand"
			>{frame.id.toUpperCase()}</a
		>
		<span class="text-sm font-medium">{frame.label}</span>
	</figcaption>
	<div
		data-frame
		class="overflow-hidden border bg-background shadow-[0_18px_40px_-18px_rgb(0_0_0/0.35)] {frame.desktop
			? 'rounded-xl'
			: 'rounded-[2rem]'}"
		style="height: {h}px"
		{onclickcapture}
	>
		<frame.screen {...frame.props} />
	</div>
</figure>
