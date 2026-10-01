<script lang="ts">
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { byDay } from '$lib/ui/format/time';
	import ListScreen from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import WriteRow from './components/write-row.svelte';
	import type { MemoryWriteRecord } from './types';

	let {
		remote,
		writes,
		now,
		back,
		online = true,
		writeHref = (id) => `/memory/writes/${id}`,
		onretry
	}: {
		remote: RemoteLike;
		writes: MemoryWriteRecord[];
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		writeHref?: (id: string) => string;
		onretry?: () => void;
	} = $props();

	const sections = $derived(byDay(writes, (w) => Date.parse(w.at), now));
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [0, 1, 2] as i (i)}
			<div class="flex flex-col gap-2 px-2 py-3">
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="h-3 w-1/2" />
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading changes…</p>
{/snippet}

{#snippet row(w: MemoryWriteRecord)}
	<WriteRow write={w} {now} href={writeHref(w.id)} />
{/snippet}

<ListScreen
	title="Memory changes"
	{back}
	{banner}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load the changes.",
		onretry,
		skeleton,
		empty: {
			title: 'No changes yet',
			body: 'Every time the agent writes to memory, the change shows here with its diff.'
		}
	}}
	{sections}
	key={(w) => w.id}
	{row}
/>
