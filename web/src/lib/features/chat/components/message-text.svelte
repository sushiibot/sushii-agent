<script lang="ts">
	import { cn } from '$lib/utils';
	import Markdown from '../render/markdown.svelte';
	import type { ComponentProps } from 'svelte';
	let {
		text,
		owner = false,
		partial = false,
		streaming = false,
		markdown = false,
		files
	}: {
		text: string;
		owner?: boolean;
		partial?: boolean;
		streaming?: boolean;
		markdown?: boolean;
		files?: ComponentProps<typeof Markdown>['files'];
	} = $props();
</script>

{#if markdown}
	<div data-message-text class={cn(partial && 'text-muted-foreground italic')}>
		<Markdown {text} {streaming} {files} />
	</div>
{:else}
	<p
		data-message-text
		class={cn(
			'[overflow-wrap:anywhere] whitespace-pre-wrap',
			owner
				? 'max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-body leading-snug [@media(hover:hover)]:max-w-full'
				: 'text-body leading-relaxed',
			owner && (partial ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'),
			partial && 'text-muted-foreground italic',
			streaming &&
				"min-h-[4.5lh] after:ml-0.5 after:inline-block after:h-[1.1em] after:w-0.5 after:translate-y-[3px] after:animate-pulse after:bg-foreground after:content-[''] motion-reduce:after:animate-none"
		)}
	>
		{text}
	</p>
{/if}
