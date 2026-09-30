<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import { pushState } from '$app/navigation';
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import CornerDownRight from '@lucide/svelte/icons/corner-down-right';
	import Frame from './components/frame.svelte';
	import Connector from './components/connector.svelte';
	import { flows } from './flows';

	let width = $state(414);
	let dark = $state(false);

	function go(id: string) {
		const el = document.getElementById(id);
		if (!el) return;
		pushState(`#${id}`, {});
		const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
		el.scrollIntoView({
			behavior: still ? 'instant' : 'smooth',
			block: 'center',
			inline: 'center'
		});
		if (!still)
			el.querySelector('[data-frame]')?.animate(
				[
					{ boxShadow: '0 0 0 0 var(--brand)' },
					{ boxShadow: '0 0 0 6px color-mix(in oklch, var(--brand) 45%, transparent)' },
					{ boxShadow: '0 0 0 0 transparent' }
				],
				{ duration: 1100, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', delay: 250 }
			);
	}
	setContext('proto-go', go);

	onMount(() => {
		dark = document.documentElement.classList.contains('dark');
		const id = location.hash.slice(1);
		if (id) document.getElementById(id)?.scrollIntoView({ block: 'center', inline: 'center' });
	});

	function toggleTheme() {
		dark = !dark;
		document.documentElement.classList.toggle('dark', dark);
		try {
			localStorage.setItem('theme', dark ? 'dark' : 'light');
		} catch {
			// Private mode: the toggle still works for this page view.
		}
	}
</script>

<svelte:head><title>Personal agent flows</title></svelte:head>

<div class="min-h-screen bg-muted/40">
	<header class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm">
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
			<div class="flex flex-col">
				<h1 class="text-lg font-semibold tracking-tight">Personal agent · flow board</h1>
				<p class="text-sm text-muted-foreground">
					Clickable prototype. Fixture data only, nothing is sent.
				</p>
			</div>
			<div class="ml-auto flex items-center gap-2">
				<div role="group" aria-label="Phone width" class="flex rounded-full border bg-card p-0.5">
					{#each [414, 320] as w (w)}
						<button
							type="button"
							aria-pressed={width === w}
							onclick={() => (width = w)}
							class="rounded-full px-3 py-1 text-sm font-medium tabular-nums {width === w
								? 'bg-foreground text-background'
								: 'text-muted-foreground hover:text-foreground'}">{w}px</button
						>
					{/each}
				</div>
				<button
					type="button"
					onclick={toggleTheme}
					aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
					class="grid size-9 place-items-center rounded-full border bg-card text-muted-foreground hover:text-foreground"
				>
					{#if dark}<Sun class="size-4" />{:else}<Moon class="size-4" />{/if}
				</button>
			</div>
		</div>
		<nav aria-label="Flows" class="flex gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
			{#each flows as flow (flow.id)}
				<a
					href="#{flow.id}"
					class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
				>
					<span class="font-mono text-[11px] font-semibold">{flow.code}</span>{flow.title}
				</a>
			{/each}
		</nav>
	</header>

	<main class="flex flex-col gap-16 px-4 py-8 sm:px-6">
		{#each flows as flow (flow.id)}
			{@const row = flow.frames.filter((fr) => !fr.desktop && !fr.branch)}
			{@const branches = flow.frames.filter((fr) => fr.branch)}
			{@const desktop = flow.frames.filter((fr) => fr.desktop)}
			<section id={flow.id} aria-labelledby="{flow.id}-h" class="flex scroll-mt-32 flex-col gap-5">
				<div class="flex max-w-prose flex-col gap-1">
					<h2
						id="{flow.id}-h"
						class="flex items-baseline gap-2 text-xl font-semibold tracking-tight"
					>
						<span class="font-mono text-sm text-muted-foreground">{flow.code}</span>{flow.title}
					</h2>
					<p class="text-[15px] text-muted-foreground">{flow.intro}</p>
				</div>

				<div class="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
					<div class="flex w-max items-start">
						{#each row as frame, i (frame.id)}
							<Frame {frame} {width} />
							{#if i < row.length - 1}<Connector label={frame.next} />{/if}
						{/each}
					</div>
				</div>

				{#each branches as frame (frame.id)}
					<div class="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
						<div class="flex w-max items-start gap-4">
							<span
								class="mt-10 inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-sm font-medium"
							>
								<CornerDownRight class="size-4 text-brand" aria-hidden="true" />{frame.branch}
							</span>
							<Frame {frame} {width} />
						</div>
					</div>
				{/each}

				{#if desktop.length}
					<div class="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
						<div class="flex w-max items-start gap-10">
							{#each desktop as frame (frame.id)}<Frame {frame} {width} />{/each}
						</div>
					</div>
				{/if}
			</section>
		{/each}
	</main>
</div>
