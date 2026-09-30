<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	let { label }: { label?: string } = $props();
</script>

<div
	class="flex w-24 shrink-0 flex-col items-center gap-1.5 self-start pt-72 text-center"
	aria-hidden="true"
>
	<ArrowRight class="size-5 text-brand" />
	{#if label}<span class="text-xs leading-tight font-medium text-muted-foreground">{label}</span
		>{/if}
</div>
