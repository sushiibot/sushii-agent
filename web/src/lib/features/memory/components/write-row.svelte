<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { ago } from '$lib/ui/format/time';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { MemoryWriteRecord } from '../types';

	let { write, now, href }: { write: MemoryWriteRecord; now: number; href: string } = $props();
</script>

<a
	{href}
	class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
>
	<span class="flex min-w-0 flex-1 flex-col gap-1">
		<span class="text-ui font-medium [overflow-wrap:anywhere]">{write.summary}</span>
		<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
			<span class="font-mono [overflow-wrap:anywhere]">{write.path}</span>
			<span aria-hidden="true">·</span>
			<span class="tabular-nums">{ago(write.at, now)}</span>
			{#if write.thread}<span>From thread · {write.thread.title}</span>{/if}
		</span>
		{#if write.taint || write.reverted}
			<span class="flex flex-wrap gap-1.5">
				{#if write.taint}<StatePill of="tainted" />{/if}
				{#if write.reverted}<StatePill of="archived" label="Reverted" />{/if}
			</span>
		{/if}
	</span>
	<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
</a>
