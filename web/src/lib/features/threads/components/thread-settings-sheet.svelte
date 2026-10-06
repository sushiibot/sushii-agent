<script lang="ts">
	import { untrack } from 'svelte';
	import Archive from '@lucide/svelte/icons/archive';
	import Pencil from '@lucide/svelte/icons/pencil';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import type { ThreadSummary } from '../types';

	let {
		open,
		thread,
		busy = false,
		error = null,
		onrename,
		onarchive,
		onclose
	}: {
		open: boolean;
		thread?: ThreadSummary;
		busy?: boolean;
		error?: string | null;
		onrename?: (title: string) => void;
		onarchive?: () => void;
		onclose?: () => void;
	} = $props();
	const uid = $props.id();
	let title = $state('');
	let confirmArchive = $state(false);
	let wasOpen = false;
	let shownId: string | undefined;
	$effect(() => {
		const nextOpen = open;
		const nextId = thread?.id;
		untrack(() => {
			if (nextOpen && (!wasOpen || nextId !== shownId)) {
				title = thread?.title ?? '';
				confirmArchive = false;
			}
			wasOpen = nextOpen;
			shownId = nextId;
		});
	});
	const ready = $derived(!!title.trim() && title.trim() !== thread?.title && !busy);
</script>

<RoutedSheet {open} label="Conversation settings" {onclose}>
	<form
		class="flex flex-col gap-4 px-5 pt-2 pb-5"
		onsubmit={(e) => {
			e.preventDefault();
			if (ready && !confirmArchive) onrename?.(title.trim());
		}}
	>
		<h2 class="text-lg font-semibold">Conversation settings</h2>
		{#if confirmArchive}
			<p class="text-body">Archive {thread?.title}?</p>
			<p class="text-sm text-muted-foreground">
				Its history stays available. Send a message to continue later.
			</p>
			<Button size="lg" disabled={busy} onclick={onarchive}>
				{#if busy}<LoaderCircle
						class="animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>{:else}<Archive />{/if}Archive conversation
			</Button>
			<Button variant="ghost" size="lg" disabled={busy} onclick={() => (confirmArchive = false)}
				>Keep current</Button
			>
		{:else}
			<div class="flex flex-col gap-2">
				<label for="{uid}-name" class="text-sm font-medium">Conversation name</label>
				<Input
					id="{uid}-name"
					bind:value={title}
					maxlength={120}
					required
					class="h-12 text-base"
					data-autofocus
				/>
			</div>
			<Button type="submit" size="lg" disabled={!ready}>
				{#if busy}<LoaderCircle
						class="animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>Saving…{:else}<Pencil />Save name{/if}
			</Button>
			{#if thread?.state !== 'archived' && onarchive}
				<Button variant="outline" size="lg" disabled={busy} onclick={() => (confirmArchive = true)}
					><Archive />Archive conversation</Button
				>
			{/if}
		{/if}
		{#if error}<p role="alert" class="text-sm text-failed">
				Couldn't update the conversation. {error}
			</p>{/if}
		<Button variant="ghost" size="lg" disabled={busy} onclick={onclose}>Close</Button>
	</form>
</RoutedSheet>
