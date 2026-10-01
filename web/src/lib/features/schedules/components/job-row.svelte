<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import { nextRunLine } from '../format';
	import type { Job } from '../types';

	let { job, now, href }: { job: Job; now: number; href: string } = $props();
</script>

<a
	{href}
	class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
>
	<span class="flex min-w-0 flex-1 flex-col gap-1">
		<span class="flex flex-wrap items-baseline justify-between gap-x-3">
			<span class="text-ui font-medium">{job.name}</span>
			<span class="text-meta text-muted-foreground">{job.schedule}</span>
		</span>
		{#if job.last}
			<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
				<StatePill of={job.last.result} />
				<span class="min-w-0 text-meta [overflow-wrap:anywhere] text-muted-foreground"
					>{job.last.note}</span
				>
			</span>
		{/if}
		<span class="text-meta text-muted-foreground tabular-nums">{nextRunLine(job, now)}</span>
	</span>
	<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
</a>
