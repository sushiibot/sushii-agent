<script lang="ts">
	import { cn } from '$lib/utils';
	import { status, toneClass, type StatusKey } from './status';

	let { of, label, class: className }: { of: StatusKey; label?: string; class?: string } = $props();
	const meta = $derived(status[of]);
</script>

<span
	class={cn(
		'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
		toneClass[meta.tone],
		className
	)}
>
	<meta.icon
		class={cn('size-3.5', of === 'running' && 'animate-spin motion-reduce:animate-none')}
		aria-hidden="true"
	/>
	{label ?? meta.label}
</span>
