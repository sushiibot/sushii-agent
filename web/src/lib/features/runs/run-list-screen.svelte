<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { byDay } from '$lib/ui/format/time';
	import TabbedScreen from '$lib/ui/screen/tabbed-screen.svelte';
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
	type Snapshot = {
		runs: RunSummary[];
		hasOlder: boolean;
		truncated: boolean;
		olderError: string | null;
	};
	let snapshots = $state<Record<string, Snapshot>>({});
	$effect(() => {
		if (remote.status === 'ready') snapshots[filter] = { runs, hasOlder, truncated, olderError };
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
		if (value === filter && remote.status === 'error' && !snapshots[value]) return remote;
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
	{@const current = value === filter}
	{@const saved = snapshots[value]}
	{@const older = current ? hasOlder : saved?.hasOlder}
	{@const limited = current ? truncated : saved?.truncated}
	{@const loading = current && olderLoading}
	{@const error = current ? olderError : saved?.olderError}
	{#if older}
		<Button
			variant="outline"
			class="self-start"
			disabled={loading}
			onclick={() => current && onloadolder?.()}
		>
			{#if loading}<LoaderCircle
					class="animate-spin motion-reduce:animate-none"
					aria-hidden="true"
				/>Loading older runs…{:else}<ChevronDown />Show older runs{/if}
		</Button>
		{#if error}<p role="alert" class="text-sm text-failed">
				Couldn't load older runs. {error}
			</p>{/if}
	{:else if limited}<p class="px-1 text-sm text-muted-foreground">
			Older runs are in <a href={historyHref} class="underline underline-offset-4">History</a>.
		</p>{/if}
{/snippet}

<TabbedScreen
	title="Runs"
	{back}
	{banner}
	{tabs}
	value={filter}
	onchange={(value) => onfilter?.(value as RunFilter)}
	label="Type of run"
	{lead}
>
	{#snippet children(value)}
		{@const shown = RUN_FILTERS.find((f) => f.value === value) ?? RUN_FILTERS[0]}
		{@const sections = byDay(panelRuns(value), runTime, now)}
		<div class="flex flex-col gap-5">
			<p class="text-sm text-muted-foreground">{shown.description}</p>
			{#if value === filter && remote.status === 'loading' && snapshots[value]}<p
					role="status"
					class="sr-only"
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
						<h2 id={`${uid}-${value}-s${i}`} class="px-1 text-sm font-medium text-muted-foreground">
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
			{#if value === filter && remote.status === 'error' && snapshots[value]}
				<div role="alert" class="flex flex-col items-start gap-2">
					<p class="text-sm text-failed">Couldn't refresh runs. {remote.error}</p>
					<Button variant="outline" onclick={onretry}>Retry refresh</Button>
				</div>
			{/if}
		</div>
	{/snippet}
</TabbedScreen>
