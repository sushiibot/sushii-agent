<script lang="ts">
	import { onMount } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Plus from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import SearchField from '$lib/ui/input/search-field.svelte';

	let {
		conversations,
		busy = false,
		error = null,
		onchoose,
		oncreate,
		onback
	}: {
		conversations: { id: string; title: string }[];
		busy?: boolean;
		error?: string | null;
		onchoose: (id: string) => void;
		oncreate: (title: string) => void;
		onback: () => void;
	} = $props();
	let heading: HTMLHeadingElement;
	onMount(() => heading.focus({ preventScroll: true }));
	let query = $state('');
	let creating = $state(false);
	let title = $state('');
	const matches = $derived(
		conversations.filter((conversation) =>
			conversation.title.toLowerCase().includes(query.trim().toLowerCase())
		)
	);
	const uid = $props.id();
</script>

<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
	<h2 bind:this={heading} tabindex="-1" class="text-lg font-semibold outline-none">
		Discuss in a conversation
	</h2>
	<p class="text-sm text-muted-foreground">
		Choose where to discuss this item. It opens as a draft for you to review.
	</p>
	{#if creating}
		<form
			class="flex flex-col gap-3"
			onsubmit={(event) => {
				event.preventDefault();
				if (title.trim() && !busy) oncreate(title.trim());
			}}
		>
			<label for="{uid}-title" class="text-sm font-medium">Conversation name</label>
			<Input
				class="min-h-12"
				id="{uid}-title"
				bind:value={title}
				maxlength={120}
				disabled={busy}
				data-autofocus
			/>
			<Button type="submit" disabled={busy || !title.trim()}
				>{busy ? 'Creating…' : 'Create conversation'}</Button
			>
			<Button variant="ghost" disabled={busy} onclick={() => (creating = false)}
				>Choose an existing conversation</Button
			>
		</form>
	{:else}
		<Button variant="outline" disabled={busy} onclick={() => onchoose('main')}
			><MessageSquare />Main chat</Button
		>
		<Button variant="outline" disabled={busy} onclick={() => (creating = true)}
			><Plus />New conversation</Button
		>
		<SearchField label="Find a conversation" bind:value={query} />
		<ul class="flex flex-col gap-2">
			{#each matches as conversation (conversation.id)}
				<li>
					<Button
						variant="ghost"
						class="h-auto min-h-12 w-full justify-start whitespace-normal"
						disabled={busy}
						onclick={() => onchoose(conversation.id)}
						><MessageSquare class="shrink-0" /><span
							class="min-w-0 text-left [overflow-wrap:anywhere]">{conversation.title}</span
						></Button
					>
				</li>
			{/each}
		</ul>
		{#if query && !matches.length}<p role="status" class="text-sm text-muted-foreground">
				No conversations match.
			</p>{/if}
	{/if}
	{#if error}<p role="alert" class="text-sm text-failed">{error}</p>{/if}
	{#if busy && !creating}<p role="status" class="text-sm text-muted-foreground">
			Opening conversation…
		</p>{/if}
	<Button variant="ghost" disabled={busy} onclick={onback}><ArrowLeft />Back to item</Button>
</div>
