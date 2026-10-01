<script lang="ts">
	import { ago } from '$lib/ui/format/time';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import { cn } from '$lib/utils';
	import ConversationIcon from './conversation-icon.svelte';
	import type { MainSummary, ThreadSummary } from '../types';

	let {
		thread,
		main,
		href,
		now
	}: {
		/** A thread's row, or Main's when `main` is set. */
		thread?: ThreadSummary;
		main?: MainSummary;
		href: string;
		now: number;
	} = $props();

	const row = $derived(main ?? thread!);
	const title = $derived(main ? 'Main' : thread!.title);
	const archived = $derived(!main && thread?.state === 'archived');
</script>

<a
	{href}
	class={cn(
		'flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60',
		archived && 'text-muted-foreground'
	)}
>
	<ConversationIcon main={!!main} class={main ? 'size-11' : 'size-10'} />
	<span class="flex min-w-0 flex-1 flex-col gap-0.5">
		<span class="flex items-baseline justify-between gap-3">
			<span class={cn('truncate', main ? 'text-base font-semibold' : 'text-ui font-medium')}
				>{title}</span
			>
			<span class="shrink-0 text-meta text-muted-foreground tabular-nums"
				>{ago(row.lastActivity, now)}</span
			>
		</span>
		<span class="flex items-center gap-2">
			<span class="line-clamp-1 flex-1 text-sm [overflow-wrap:anywhere] text-muted-foreground"
				>{row.preview}</span
			>
			{#if row.state === 'needs-you'}
				<StatePill of="waiting" label="Needs you" />
			{:else if row.state === 'running'}
				<StatePill of="running" />
			{:else if row.unread}
				<span
					class="min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center text-meta leading-5 font-semibold text-primary-foreground tabular-nums"
					>{row.unread}<span class="sr-only"> unread</span></span
				>
			{/if}
		</span>
	</span>
</a>
