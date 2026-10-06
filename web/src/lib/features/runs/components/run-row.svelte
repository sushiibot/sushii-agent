<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { ago } from '$lib/ui/format/time';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import { kindLabel, activityTitle } from '../format';
	import type { RunSummary } from '../types';

	let { run, now, href }: { run: RunSummary; now: number; href: string } = $props();
</script>

<a
	{href}
	class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
>
	<span class="flex min-w-0 flex-1 flex-col gap-1">
		<span class="line-clamp-2 text-ui font-medium [overflow-wrap:anywhere]"
			>{run.kind === 'chat' ? run.title : activityTitle(run)}</span
		>
		<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
			<StatePill of={run.status} label={run.status === 'done' ? 'Finished' : undefined} />
			<span class="[overflow-wrap:anywhere]">{kindLabel(run)}</span>
			{#if run.kind === 'chat'}
				<span
					>{run.conversationId && run.conversationId !== 'main'
						? 'Topic conversation'
						: 'Main conversation'}</span
				>
			{/if}
			{#if run.repo}<span class="[overflow-wrap:anywhere]">{run.repo}</span>{/if}
			<span aria-hidden="true">·</span>
			<span class="tabular-nums">{ago(run.startedAt, now)}</span>
		</span>
	</span>
	<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
</a>
