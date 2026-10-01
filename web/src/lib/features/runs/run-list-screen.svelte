<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import * as RadioGroup from '$lib/ui/radio-group';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { byDay } from '$lib/ui/format/time';
	import ListScreen from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import RunRow from './components/run-row.svelte';
	import { RUN_FILTERS, runTime, type RunFilter } from './format';
	import type { RunSummary } from './types';

	let {
		remote,
		runs,
		now,
		back,
		hasOlder = false,
		olderLoading = false,
		olderError = null,
		truncated = false,
		online = true,
		runHref = (id) => `/runs/${id}`,
		historyHref = '/history',
		filter = 'all',
		onfilter,
		onretry,
		onloadolder
	}: {
		remote: RemoteLike;
		runs: RunSummary[];
		now: number;
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		hasOlder?: boolean;
		olderLoading?: boolean;
		olderError?: string | null;
		/** Older runs exist that only History can reach. */
		truncated?: boolean;
		online?: boolean;
		runHref?: (runId: string) => string;
		historyHref?: string;
		filter?: RunFilter;
		/** Shows the type filter when set. */
		onfilter?: (filter: RunFilter) => void;
		onretry?: () => void;
		onloadolder?: () => void;
	} = $props();

	const sections = $derived(byDay(runs, runTime, now));
	const shown = $derived(RUN_FILTERS.find((f) => f.value === filter) ?? RUN_FILTERS[0]);
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet lead()}
	{#if onfilter}
		<RadioGroup.Root
			value={filter}
			onValueChange={(v) => onfilter(v as RunFilter)}
			orientation="horizontal"
			aria-label="Type of run"
			class="flex w-auto flex-wrap gap-2"
		>
			{#each RUN_FILTERS as f (f.value)}
				<RadioGroup.Card value={f.value} class="shrink-0 rounded-full px-4"
					>{f.label}</RadioGroup.Card
				>
			{/each}
		</RadioGroup.Root>
	{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-2" aria-hidden="true">
		<Skeleton class="h-4 w-20" />
		{#each [0, 1, 2, 3] as i (i)}
			<div class="flex flex-col gap-2 px-2 py-3">
				<Skeleton class="h-4 w-4/5" />
				<Skeleton class="h-3 w-1/2" />
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading runs…</p>
{/snippet}

{#snippet row(run: RunSummary)}
	<RunRow {run} {now} href={runHref(run.runId)} />
{/snippet}

{#snippet after()}
	{#if hasOlder}
		<Button variant="outline" disabled={olderLoading} onclick={() => onloadolder?.()}>
			{#if olderLoading}
				<LoaderCircle class="animate-spin motion-reduce:animate-none" aria-hidden="true" />Loading
				older runs…
			{:else}
				<ChevronDown />Show older runs
			{/if}
		</Button>
		{#if olderError}
			<p role="alert" class="text-sm text-failed">Couldn't load older runs. {olderError}</p>
		{/if}
	{:else if truncated}
		<p class="px-1 text-sm text-muted-foreground">
			Older runs are in <a href={historyHref} class="underline underline-offset-4">History</a>.
		</p>
	{/if}
{/snippet}

<ListScreen
	title="Runs"
	{back}
	{banner}
	lead={onfilter ? lead : undefined}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load runs.",
		onretry,
		skeleton,
		empty:
			filter === 'all'
				? {
						title: 'No runs yet',
						body: 'Chat turns, scheduled jobs and background work show up here once they run.'
					}
				: {
						title: `No ${shown.noun} yet`,
						body: 'They show up here once one runs.',
						action: onfilter && { label: 'Show all runs', onclick: () => onfilter('all') }
					}
	}}
	{sections}
	key={(r) => r.runId}
	{row}
	{after}
/>
