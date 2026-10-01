<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FileText from '@lucide/svelte/icons/file-text';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import NotebookText from '@lucide/svelte/icons/notebook-text';
	import { ago, dayLabel, fromDate } from '$lib/ui/format/time';
	import type { SearchHit } from '../types';
	import Highlight from './highlight.svelte';

	let {
		hit,
		now,
		href
	}: {
		hit: SearchHit;
		now: number;
		/** Where the hit opens; chat hits have no page of their own yet. */
		href?: string;
	} = $props();

	const source = $derived(
		hit.source === 'chat'
			? { label: hit.role === 'user' ? 'Chat · you' : 'Chat · the agent', icon: MessageSquare }
			: hit.kind === 'run'
				? { label: 'Run notes', icon: FileText }
				: { label: 'Day notes', icon: NotebookText }
	);
	const when = $derived(
		hit.source === 'chat' ? ago(hit.at, now) : dayLabel(fromDate(hit.date), now)
	);
</script>

{#snippet body()}
	<span class="flex min-w-0 flex-1 flex-col gap-1">
		<span class="flex items-center gap-1.5 text-meta text-muted-foreground">
			<source.icon class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="font-medium">{source.label}</span>
			<span aria-hidden="true">·</span>
			<span class="tabular-nums">{when}</span>
		</span>
		{#if hit.source === 'notes' && hit.heading}
			<span class="text-ui font-medium [overflow-wrap:anywhere]">{hit.heading}</span>
		{/if}
		<span class="line-clamp-3 text-sm [overflow-wrap:anywhere]"
			><Highlight text={hit.snippet} ranges={hit.ranges} /></span
		>
	</span>
{/snippet}

{#if href}
	<a
		{href}
		class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
	>
		{@render body()}
		<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	</a>
{:else}
	<div class="flex min-h-16 items-center gap-3 px-2 py-2.5">{@render body()}</div>
{/if}
