<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import SwipeableTabs from '$lib/ui/tabs/swipeable-tabs.svelte';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { byDay } from '$lib/ui/format/time';
	import Screen from '$lib/ui/screen/screen.svelte';
	import ScreenState from '$lib/ui/screen/screen-state.svelte';
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

	const uid = $props.id();
	type Snapshot = { runs: RunSummary[]; hasOlder: boolean; truncated: boolean };
	let snapshots = $state<Record<string, Snapshot>>({});
	$effect(() => {
		if (remote.status === 'ready') snapshots[filter] = { runs, hasOlder, truncated };
	});
	const tabs = $derived(
		(onfilter ? RUN_FILTERS : [RUN_FILTERS[0]]).map((f) => ({ value: f.value, label: f.label }))
	);
	function panelRuns(value: string) {
		if (value === filter && remote.status === 'ready') return runs;
		const saved = snapshots[value];
		if (saved) return saved.runs;
		const kinds = RUN_FILTERS.find((f) => f.value === value)?.kinds;
		return (snapshots.all?.runs ?? []).filter((r) => !kinds || kinds.includes(r.kind));
	}
	function panelRemote(value: string): RemoteLike {
		if (value === filter && remote.status === 'error') return remote;
		if (
			snapshots[value] ||
			(value === filter && remote.status === 'ready') ||
			panelRuns(value).length
		)
			return { status: 'ready' };
		return value === filter ? remote : { status: 'loading', slow: true };
	}
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet lead()}
	<p class="text-sm text-muted-foreground">
		A run is one attempt by the agent to respond or complete a task. Open it for the steps, result
		and evidence.
	</p>
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

{#snippet after(value: string)}
	{@const older = value === filter ? hasOlder : snapshots[value]?.hasOlder}
	{@const limited = value === filter ? truncated : snapshots[value]?.truncated}
	{#if older}
		<Button variant="outline" disabled={olderLoading} onclick={() => onloadolder?.()}>
			{#if olderLoading}<LoaderCircle
					class="animate-spin motion-reduce:animate-none"
					aria-hidden="true"
				/>Loading older runs…{:else}<ChevronDown />Show older runs{/if}
		</Button>
		{#if olderError}<p role="alert" class="text-sm text-failed">
				Couldn't load older runs. {olderError}
			</p>{/if}
	{:else if limited}<p class="px-1 text-sm text-muted-foreground">
			Older runs are in <a href={historyHref} class="underline underline-offset-4">History</a>.
		</p>{/if}
{/snippet}

<Screen title="Runs" {back} {banner}>
	<div class="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col px-4 pt-4">
		<SwipeableTabs
			{tabs}
			value={filter}
			onchange={(value) => onfilter?.(value as RunFilter)}
			label="Type of run"
			{lead}
		>
			{#snippet children(value)}
				{@const shown = RUN_FILTERS.find((f) => f.value === value) ?? RUN_FILTERS[0]}
				{@const sections = byDay(panelRuns(value), runTime, now)}
				<div class="flex flex-col gap-5 pb-10">
					<p class="text-sm text-muted-foreground">{shown.description}</p>
					{#if value === filter && remote.status === 'loading' && snapshots[value]}<p
							role="status"
							class="text-sm text-muted-foreground"
						>
							Updating runs…
						</p>{/if}
					<ScreenState
						remote={panelRemote(value)}
						offline={!online}
						errorTitle="Couldn't load runs."
						{onretry}
						{skeleton}
						isEmpty={!sections.length}
						empty={value === 'all'
							? {
									title: 'No runs yet',
									body: 'Chat turns, scheduled jobs and background work show up here once they run.'
								}
							: {
									title: `No ${shown.noun} yet`,
									body: 'They show up here once one runs.',
									action: onfilter && { label: 'Show all runs', onclick: () => onfilter('all') }
								}}
					>
						{#each sections as group, i (group.label)}
							<section aria-labelledby={`${uid}-${value}-s${i}`} class="flex flex-col gap-1">
								<h2
									id={`${uid}-${value}-s${i}`}
									class="px-1 text-sm font-medium text-muted-foreground"
								>
									{group.label}
								</h2>
								<ul class="flex flex-col">
									{#each group.items as run (run.runId)}<li class="min-h-12">
											{@render row(run)}
										</li>{/each}
								</ul>
							</section>
						{/each}
						{@render after(value)}
					</ScreenState>
				</div>
			{/snippet}
		</SwipeableTabs>
	</div>
</Screen>
