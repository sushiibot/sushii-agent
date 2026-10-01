<script lang="ts">
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import { cn } from '$lib/utils';

	let { main = false, class: className }: { main?: boolean; class?: string } = $props();
</script>

<span
	class={cn(
		'grid shrink-0 place-items-center rounded-lg',
		main ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
		className
	)}
	aria-hidden="true"
>
	{#if main}
		<svg viewBox="0 0 16 16" class="size-[55%]"
			><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2" /><circle
				cx="8"
				cy="8"
				r="1.6"
				fill="currentColor"
			/></svg
		>
	{:else}
		<MessageSquare class="size-[50%]" />
	{/if}
</span>
