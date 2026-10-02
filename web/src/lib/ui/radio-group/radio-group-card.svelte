<script lang="ts">
	import type { Snippet } from 'svelte';
	import { RadioGroup as RadioGroupPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils';

	let {
		value,
		compact = false,
		class: className,
		children
	}: { value: string; compact?: boolean; class?: string; children: Snippet } = $props();
</script>

<RadioGroupPrimitive.Item
	{value}
	class={cn(
		'group h-12 min-w-12 text-sm font-medium text-muted-foreground data-checked:text-foreground',
		compact
			? 'flex shrink-0 items-center'
			: 'rounded-xl border bg-card data-checked:border-foreground',
		className
	)}
>
	{#if compact}
		<span
			class="flex h-8 items-center justify-center rounded-full border bg-card px-3 group-data-checked:border-foreground"
			>{@render children()}</span
		>
	{:else}
		{@render children()}
	{/if}
</RadioGroupPrimitive.Item>
