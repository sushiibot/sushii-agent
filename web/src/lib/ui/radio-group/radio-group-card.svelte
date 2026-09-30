<script lang="ts">
	import type { Snippet } from 'svelte';
	import { RadioGroup as RadioGroupPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils';

	let {
		value,
		class: className,
		children
	}: { value: string; class?: string; children: Snippet } = $props();
</script>

<RadioGroupPrimitive.Item
	{value}
	class={cn(
		'h-12 rounded-xl border bg-card text-sm font-medium text-muted-foreground data-checked:border-foreground data-checked:text-foreground',
		className
	)}
>
	{@render children()}
</RadioGroupPrimitive.Item>
