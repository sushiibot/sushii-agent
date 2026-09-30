<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import { Button } from '$lib/ui/button';
	import AppShell from '$lib/ui/shell/app-shell.svelte';

	let { path, content, runId }: { path: string; content: string; runId: string } = $props();
	const lines = $derived(content.trimEnd().split('\n'));
</script>

<AppShell
	active="history"
	title={path.split('/').at(-1) ?? path}
	back={{ href: '/history', label: 'History' }}
	waiting={2}
>
	{#snippet actions()}
		<Button variant="ghost" size="icon-lg" aria-label="Copy file"><Copy /></Button>
	{/snippet}
	<div class="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 @3xl:py-8">
		<p class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
			<code class="font-mono">~/{path}</code>
			<a
				href="/runs/{runId}"
				class="inline-flex items-center gap-1 font-medium text-brand hover:underline"
			>
				Run detail<ArrowUpRight class="size-3.5" aria-hidden="true" />
			</a>
		</p>
		<div class="rounded-lg border bg-card px-4 py-4 text-sm leading-relaxed">
			{#each lines as line, i (i)}
				{#if line.startsWith('# ')}
					<h2 class="mb-2 text-lg font-semibold">{line.slice(2)}</h2>
				{:else if line.startsWith('## ')}
					<h3 class="mt-4 mb-1 font-semibold">{line.slice(3)}</h3>
				{:else if line === ''}
					<div class="h-1"></div>
				{:else}
					<p class="font-mono text-[13px] break-words text-foreground/90">{line}</p>
				{/if}
			{/each}
		</div>
	</div>
</AppShell>
