<script lang="ts">
	import Info from '@lucide/svelte/icons/info';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import ListScreen from '$lib/ui/screen/list-screen.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import HitRow from './components/hit-row.svelte';
	import { QUERY_MIN, type SearchHit, type SearchResult } from './types';

	let {
		query = $bindable(''),
		status,
		slow = false,
		error = null,
		result,
		now,
		back,
		online = true,
		autofocus = false,
		runHref = (id) => `/runs/${id}`,
		dayHref = (date) => `/history/${date}`,
		onretry
	}: {
		query?: string;
		status: 'idle' | 'loading' | 'ready' | 'error';
		slow?: boolean;
		error?: string | null;
		result: SearchResult | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		/** Focus the field on open, so the keyboard comes up. */
		autofocus?: boolean;
		runHref?: (runId: string) => string;
		dayHref?: (date: string) => string;
		onretry?: () => void;
	} = $props();

	let input = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (autofocus && input) input.focus();
	});

	const short = $derived(Array.from(query.trim()).length < QUERY_MIN);
	const hits = $derived(short ? [] : (result?.hits ?? []));
	const href = (hit: SearchHit) =>
		hit.source === 'chat'
			? undefined
			: hit.kind === 'run' && hit.runId
				? runHref(hit.runId)
				: dayHref(hit.date);
	const sourceName = { chat: 'Chat', notes: 'Run notes' };
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-2" aria-hidden="true">
		{#each [0, 1, 2] as i (i)}
			<div class="flex flex-col gap-2 px-2 py-3">
				<Skeleton class="h-3 w-1/3" />
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-2/3" />
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Searching…</p>
{/snippet}

{#snippet row(hit: SearchHit)}
	<HitRow {hit} {now} href={href(hit)} />
{/snippet}

{#snippet after()}
	{#if status === 'loading' && slow && result}
		<p role="status" class="flex items-center gap-2 px-1 text-sm text-muted-foreground">
			<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
			Searching…
		</p>
	{/if}
	{#if result && !short}
		{#if result.unavailable.length}
			<p role="status" class="flex items-start gap-2 px-1 text-sm text-muted-foreground">
				<Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{result.unavailable.map((s) => sourceName[s]).join(' and ')} couldn't be searched just now, so
				these results are from {result.unavailable.includes('chat') ? 'run notes' : 'chat'} only.
			</p>
		{/if}
		{#if result.truncated && hits.length}
			<p role="status" class="flex items-start gap-2 px-1 text-sm text-muted-foreground">
				<Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				Search stopped early, so some matches may be missing. Try more words.
			</p>
		{/if}
	{/if}
{/snippet}

<ListScreen
	title="Search"
	{back}
	{banner}
	bind:search={query}
	bind:searchInput={input}
	searchLabel="Search chat and notes"
	state={{
		remote:
			short || (status === 'loading' && result) ? { status: 'ready' } : { status, slow, error },
		offline: !online,
		errorTitle: "Couldn't search.",
		onretry,
		skeleton,
		empty: short
			? {
					title: 'Search chat and notes',
					body: 'Finds what you and the agent said in chat, and what the agent wrote in its notes. Type at least two characters.'
				}
			: {
					title: `No results for “${query.trim()}”`,
					body: 'Search matches the exact words, ignoring case. Try fewer or different words.'
				}
	}}
	sections={[{ items: hits }]}
	isEmpty={!hits.length && !result?.unavailable.length}
	key={(h) => h.id}
	{row}
	{after}
/>
