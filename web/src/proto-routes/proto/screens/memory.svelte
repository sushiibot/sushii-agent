<script lang="ts">
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import { Button } from '$lib/ui/button';
	import { cn } from '$lib/utils';
	import AppShell from './app-shell.svelte';
	import DiffView from './diff-view.svelte';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import MemoryTabs from './memory-tabs.svelte';
	import type { MemoryChange } from './types';

	let {
		changes,
		selected,
		reverted = false
	}: { changes: MemoryChange[]; selected?: string; reverted?: boolean } = $props();
	const change = $derived(changes.find((c) => c.id === selected));
</script>

{#snippet revertToast()}
	<span class="flex-1">Change reverted</span>
	<button type="button" class="font-semibold underline underline-offset-2">Restore</button>
{/snippet}

{#snippet detail(c: MemoryChange)}
	<article class="flex flex-col gap-4">
		<header class="flex flex-col gap-2">
			<p class="font-mono text-xs text-muted-foreground">{c.file}</p>
			<h2 class="text-lg leading-snug font-semibold text-balance">{c.summary}</h2>
			<p class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
				<span>{c.when}</span>
				<span class="inline-flex items-center gap-1 font-mono text-xs">
					<GitCommitHorizontal class="size-3.5" aria-hidden="true" />{c.commit}
				</span>
				{#if c.taint}<StatePill of="tainted" label={c.taint} />{/if}
				{#if c.session}<span class="text-xs">From thread · {c.session.title}</span>{/if}
			</p>
		</header>

		<DiffView lines={c.diff} file={c.file} />

		<section class="flex flex-col gap-1 text-sm">
			<h3 class="text-xs text-muted-foreground">Written by</h3>
			<a href="/runs/{c.run.id}" class="inline-flex items-center gap-1 font-medium hover:underline">
				{c.run.title}<ArrowUpRight class="size-3.5" aria-hidden="true" />
			</a>
			{#if c.taint}
				<p class="text-muted-foreground">
					That run had already read an external email when it wrote this. Check it before the agent
					relies on it.
				</p>
			{/if}
		</section>

		{#if reverted}
			<p class="text-sm text-muted-foreground">
				Reverted in <span class="font-mono text-xs">9d1e3aa</span>. The agent won't see these lines
				from its next turn.
			</p>
		{:else}
			<Button size="lg" variant="outline" class="self-start"><Undo2 />Revert this change</Button>
		{/if}
	</article>
{/snippet}

<AppShell
	active="memory"
	title={change ? 'Memory change' : 'Memory'}
	back={change ? { href: '/memory', label: 'Memory' } : undefined}
	waiting={2}
	toast={reverted ? revertToast : undefined}
>
	<div class="@3xl:grid @3xl:h-full @3xl:grid-cols-[minmax(0,22rem)_1fr]">
		<div
			class={cn(
				'flex flex-col gap-3 px-4 py-4 @3xl:overflow-y-auto @3xl:border-r',
				change && 'hidden @3xl:flex'
			)}
		>
			<MemoryTabs active="changes" />
			<ol class="flex flex-col">
				{#each changes as c (c.id)}
					<li>
						<a
							href="/memory/{c.id}"
							aria-current={c.id === selected ? 'true' : undefined}
							class={cn(
								'flex flex-col gap-1 rounded-md px-2 py-2.5 hover:bg-muted/60',
								c.id === selected && 'bg-muted'
							)}
						>
							<span class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
								<span class="truncate font-mono">{c.file}</span>
								<span class="shrink-0">{c.when}</span>
							</span>
							<span class="text-sm font-medium">{c.summary}</span>
							{#if c.session}
								<span class="text-xs text-muted-foreground">From thread · {c.session.title}</span>
							{/if}
							{#if c.taint}<StatePill of="tainted" label={c.taint} class="mt-0.5 self-start" />{/if}
						</a>
					</li>
				{/each}
			</ol>
		</div>
		<div
			class={cn(
				'px-4 py-4 @3xl:overflow-y-auto @3xl:px-8 @3xl:py-6',
				!change && 'hidden @3xl:block'
			)}
		>
			{#if change}
				{@render detail(change)}
			{:else}
				<p class="text-sm text-muted-foreground">Pick a change to see its diff.</p>
			{/if}
		</div>
	</div>
</AppShell>
