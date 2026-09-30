<script lang="ts">
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import { cn } from '$lib/utils';
	import type { SessionKind } from './types';

	let { kind, class: className }: { kind: SessionKind; class?: string } = $props();
</script>

<span
	class={cn(
		'grid shrink-0 place-items-center rounded-lg',
		kind === 'main' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
		className
	)}
	aria-hidden="true"
>
	{#if kind === 'main'}
		<svg viewBox="0 0 16 16" class="size-[55%]"
			><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2" /><circle
				cx="8"
				cy="8"
				r="1.6"
				fill="currentColor"
			/></svg
		>
	{:else if kind === 'project'}
		<FolderGit2 class="size-[50%]" />
	{:else}
		<MessageSquare class="size-[50%]" />
	{/if}
</span>
