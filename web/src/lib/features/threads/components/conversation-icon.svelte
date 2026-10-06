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
	<MessageSquare class="size-[50%]" />
</span>
