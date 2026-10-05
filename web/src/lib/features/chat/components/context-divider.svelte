<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/ui/button';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import type { SessionBoundary } from '$lib/core/realtime/events';
	import Markdown from '../render/markdown.svelte';

	let {
		boundary,
		open = false,
		onopen,
		onclose
	}: {
		boundary: SessionBoundary;
		open?: boolean;
		onopen?: () => void;
		onclose?: () => void;
	} = $props();
	let localOpen = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	const shown = $derived(open || localOpen);
	function close() {
		localOpen = false;
		if (onclose) onclose();
		else open = false;
	}
	function show() {
		if (onopen) onopen();
		else localOpen = true;
	}
	const label = $derived(
		{
			new: boundary.initialContext ? 'Conversation started' : 'Context reset',
			rotated: 'Conversation continued',
			compacted: 'Conversation compacted'
		}[boundary.kind]
	);
</script>

<button
	bind:this={trigger}
	type="button"
	data-context-divider
	aria-haspopup="dialog"
	aria-expanded={shown}
	onclick={show}
	class="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
>
	<span class="h-px flex-1 bg-border"></span>
	<span class="flex items-center gap-1 font-medium">
		{label}<ChevronRight class="size-3.5 shrink-0" aria-hidden="true" />
	</span>
	<span class="h-px flex-1 bg-border"></span>
</button>
<RoutedSheet open={shown} {label} returnFocus={trigger} onclose={close}>
	<div
		class="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b bg-background px-5 py-2"
	>
		<h2 class="font-semibold">{label}</h2>
		<Button variant="ghost" size="icon" class="size-12" aria-label="Close" onclick={close}>
			<X aria-hidden="true" />
		</Button>
	</div>
	<div class="space-y-6 px-5 py-5 text-sm [overflow-wrap:anywhere]" data-context-details>
		<p class="text-muted-foreground">
			{#if boundary.initialContext}
				This conversation starts with the topic context below and shared workspace memory.
			{:else if boundary.kind === 'new'}
				The conversation starts fresh with shared workspace context. Its previous recap stays in
				history.
			{:else if boundary.kind === 'rotated'}
				A fresh context continues this conversation with the recap below and shared workspace
				context.
			{:else}
				Older messages were summarized. Recent messages remain in the conversation.
			{/if}
		</p>
		{#if boundary.initialContext}
			<section class="space-y-2">
				<h3 class="font-medium">Starting context</h3>
				<p class="whitespace-pre-wrap">{boundary.initialContext}</p>
			</section>
		{/if}
		{#if boundary.summary}
			<section class="space-y-2">
				<h3 class="font-medium">
					{boundary.kind === 'rotated' ? 'Recap carried forward' : 'Summary carried forward'}
				</h3>
				<Markdown text={boundary.summary} />
				{#if boundary.summaryTruncated}<p class="text-muted-foreground">
						This preview is shortened. The conversation keeps the full summary.
					</p>{/if}
			</section>
		{/if}
		{#if boundary.memory}
			<section class="space-y-2">
				<h3 class="font-medium">Saved shared memory</h3>
				<p class="text-muted-foreground">
					Changes since this conversation's previous context boundary. Other conversations can also
					update these files.
				</p>
				{#each boundary.memory.files as file}
					<details class="group/file border-b border-border">
						<summary
							class="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
						>
							<span>{file.path}<span class="ml-2 text-muted-foreground">{file.change}</span></span>
							<ChevronDown class="size-4 shrink-0 group-open/file:rotate-180" aria-hidden="true" />
						</summary>
						<div class="space-y-2 pb-4">
							{#if file.change === 'removed'}<p>
									This file was removed from shared memory.
								</p>{:else}<Markdown text={file.content} />{/if}
							{#if file.truncated}<p class="text-muted-foreground">
									This file preview is shortened.
								</p>{/if}
						</div>
					</details>
				{/each}
				{#if boundary.memory.truncated}<p class="text-muted-foreground">
						Some memory changes are not included in this snapshot.
					</p>{:else if !boundary.memory.files.length}<p class="text-muted-foreground">
						No shared-memory files changed since the previous context boundary.
					</p>{/if}
			</section>
		{/if}
		{#if boundary.context}
			<section class="space-y-2">
				<h3 class="font-medium">Workspace context loaded</h3>
				{#each boundary.context.files as file}
					<details class="group/file border-b border-border">
						<summary
							class="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
						>
							{file.path}<ChevronDown
								class="size-4 shrink-0 group-open/file:rotate-180"
								aria-hidden="true"
							/>
						</summary>
						<div class="space-y-2 pb-4">
							<Markdown text={file.content} />
							{#if file.truncated}<p class="text-muted-foreground">
									This file preview is shortened.
								</p>{/if}
						</div>
					</details>
				{/each}
				{#if boundary.context.truncated}<p class="text-muted-foreground">
						Some context files are not included in this snapshot.
					</p>{:else if !boundary.context.files.length}<p class="text-muted-foreground">
						No workspace context files were recorded.
					</p>{/if}
			</section>
		{/if}
		{#if !boundary.memory && !boundary.context && !boundary.summary && !boundary.initialContext}
			<p class="text-muted-foreground">Details were not recorded for this event.</p>
		{:else if !boundary.memory && !boundary.initialContext}
			<p class="text-muted-foreground">A shared-memory snapshot was not recorded for this event.</p>
		{/if}
	</div>
</RoutedSheet>
