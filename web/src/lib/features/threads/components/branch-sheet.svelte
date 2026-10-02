<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Split from '@lucide/svelte/icons/split';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';

	let {
		open,
		quote,
		title = $bindable(''),
		busy = false,
		error = null,
		onstart,
		onclose
	}: {
		open: boolean;
		/** The reply it starts from, as plain text; none for a thread from scratch. */
		quote?: string;
		title?: string;
		busy?: boolean;
		error?: string | null;
		onstart?: (title: string) => void;
		onclose?: () => void;
	} = $props();
	const uid = $props.id();
	const ready = $derived(title.trim().length > 0 && !busy);
</script>

<RoutedSheet {open} label="Start a thread" {onclose}>
	<form
		class="flex flex-col gap-4 px-5 pt-2 pb-5"
		onsubmit={(e) => {
			e.preventDefault();
			if (ready) onstart?.(title.trim());
		}}
	>
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold">Start a thread</h2>
			<p class="text-sm text-muted-foreground">
				A thread is its own conversation that shares memory with Main.
				{#if quote}It starts with the selected reply from Main.{:else}Give it a name, then send your
					first message.{/if}
			</p>
		</div>
		{#if quote}
			<p
				class="line-clamp-3 border-l-2 pl-3 text-sm [overflow-wrap:anywhere] text-muted-foreground"
			>
				{quote}
			</p>
		{/if}
		<div class="flex flex-col gap-2">
			<label for="{uid}-title" class="text-sm font-medium">Thread name</label>
			<Input
				id="{uid}-title"
				bind:value={title}
				maxlength={120}
				class="h-12 text-base"
				data-autofocus
			/>
		</div>
		{#if error}
			<p role="alert" class="text-sm text-failed">Couldn't start the thread. {error}</p>
		{/if}
		<div class="flex flex-col gap-2">
			<Button size="lg" type="submit" disabled={!ready}>
				{#if busy}<LoaderCircle
						class="animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>Starting the thread…{:else}<Split />Start thread{/if}
			</Button>
			<Button size="lg" variant="ghost" onclick={onclose}>Cancel</Button>
		</div>
	</form>
</RoutedSheet>
