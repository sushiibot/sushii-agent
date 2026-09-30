<script lang="ts">
	import { getContext } from 'svelte';
	import type { Frame } from '../flows';
	import { frameFor } from '../flows';
	import StatusBar from './status-bar.svelte';
	import HomeIndicator from './home-indicator.svelte';
	import Keyboard from './keyboard.svelte';
	import SafariBar from './safari-bar.svelte';
	import PushAlert from './push-alert.svelte';

	let { frame, width }: { frame: Frame; width: number } = $props();
	const go = getContext<(id: string) => void>('proto-go');

	const KB = 305;
	const w = $derived(frame.desktop ? 1280 : width);
	const h = $derived(frame.desktop ? 800 : 844);
	const chrome = $derived(frame.desktop ? 'none' : (frame.chrome ?? 'standalone'));
	// Standalone apps draw under the status bar and home indicator; Safari and desktop own those areas.
	const insets = $derived(
		chrome === 'standalone'
			? `--safe-top: 47px; --safe-bottom: 34px; --kb: ${frame.keyboard ? KB : 0}px`
			: '--safe-top: 0px; --safe-bottom: 0px; --kb: 0px'
	);
	const text = (el: Element) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

	// Screens stay free of prototype wiring: jumps come from button text or the app's own hrefs.
	function onclickcapture(e: MouseEvent) {
		const el = (e.target as Element).closest('button, a');
		if (!el) return;
		const label = text(el) || (el.getAttribute('aria-label') ?? '').toLowerCase();
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
		class="relative flex flex-col overflow-hidden border bg-background shadow-[0_18px_40px_-18px_rgb(0_0_0/0.35)] {frame.desktop
			? 'rounded-xl'
			: 'rounded-[2.75rem]'} {frame.keyboard ? 'keyboard-open' : ''}"
		style="height: {h}px; {insets}"
		{onclickcapture}
	>
		{#if chrome === 'safari'}<div class="h-[47px] shrink-0 bg-background"></div>{/if}
		<div class="relative min-h-0 flex-1">
			<frame.screen {...frame.props} />
		</div>
		{#if chrome === 'safari'}<SafariBar />{/if}
		{#if frame.keyboard}<Keyboard height={KB} suggestions={frame.keyboard} />{/if}
		{#if chrome !== 'none'}
			<StatusBar light={chrome === 'bare'} />
			<HomeIndicator light={chrome === 'bare'} />
		{/if}
		{#if frame.alert === 'push'}<PushAlert />{/if}
	</div>
</figure>
