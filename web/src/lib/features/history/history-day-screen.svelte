<script lang="ts">
	// A day's recaps are the agent's own notes: rendered through the safe markdown renderer, with no
	// files, so a planted image or link to an upload stays text.
	import { Markdown } from '$lib/features/chat';
	import { RunRow } from '$lib/features/runs';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { longDate } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import SwipeableTabs from '$lib/ui/tabs/swipeable-tabs.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import type { HistoryDayDetail } from './types';
	import { costLabel, costDescription } from './cost';

	let {
		date,
		remote,
		detail,
		now,
		back,
		online = true,
		runHref = (id) => `/runs/${id}`,
		onretry
	}: {
		date: string;
		remote: RemoteLike;
		detail: HistoryDayDetail | undefined;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		runHref?: (runId: string) => string;
		onretry?: () => void;
	} = $props();
	const uid = $props.id();
	let section = $state('recaps');
	let shownDate = $state<string>();
	$effect(() => {
		if (date !== shownDate) {
			shownDate = date;
			section = 'recaps';
		}
	});
	const day = $derived(detail?.found ? detail : null);
	const title = $derived.by(() => {
		try {
			return longDate(date, now);
		} catch {
			return 'History';
		}
	});
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-4 px-4 pt-5" aria-hidden="true">
		<Skeleton class="h-5 w-1/2" />
		<Skeleton class="h-32 w-full rounded-xl" />
		<Skeleton class="h-5 w-1/3" />
		<Skeleton class="h-24 w-full rounded-xl" />
	</div>
	<p role="status" class="sr-only">Loading the day…</p>
{/snippet}

<DetailScreen
	scrollable={!day}
	{title}
	{back}
	{banner}
	state={{
		remote: day && remote.status === 'loading' ? { status: 'ready' } : remote,
		offline: !online,
		errorTitle: "Couldn't load this day.",
		onretry,
		skeleton,
		isEmpty: !day,
		empty: {
			title: 'No notes for this day',
			body: "The agent didn't write anything that day, or the notes are no longer kept."
		}
	}}
>
	{#if day}
		<div class="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
			{#snippet lead()}
				<div class="flex flex-col gap-3 px-4 pt-4 pb-3">
					{#if day.runs.length || day.cost?.unpricedRuns || day.cost?.recordedRuns}
						<p class="text-sm text-muted-foreground" title={costDescription(day.cost)}>
							{costLabel(day.cost)}
							{#if day.cost?.unpricedRuns}
								· {day.cost.unpricedRuns}
								{day.cost.unpricedRuns === 1 ? 'run has' : 'runs have'} no recorded price
							{/if}
						</p>
					{/if}
				</div>
			{/snippet}
			<SwipeableTabs
				tabs={[
					{ value: 'recaps', label: 'Recaps' },
					{ value: 'runs', label: `Runs (${day.runs.length})` }
				]}
				bind:value={section}
				label="History sections"
				{lead}
			>
				{#snippet children(tabValue)}
					{#if tabValue === 'recaps'}
						<div class="px-4 pt-4 pb-12">
							<section aria-labelledby="{uid}-s" class="flex flex-col gap-3">
								<h2 id="{uid}-s" class="flex flex-col gap-0.5">
									<span class="text-base font-semibold">Work recaps</span>
									<span class="text-meta font-normal text-muted-foreground"
										>The agent’s written summaries of its work that day.</span
									>
								</h2>
								{#if day.sessions.length}
									{#each day.sessions as session, i (i)}
										<article
											aria-labelledby="{uid}-h{i}"
											class="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3"
										>
											<h3 id="{uid}-h{i}" class="text-ui font-semibold [overflow-wrap:anywhere]">
												{session.heading}
											</h3>
											<div class="min-w-0 [overflow-wrap:anywhere]">
												<Markdown text={session.markdown} />
											</div>
										</article>
									{/each}
								{:else}
									<p
										class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground"
									>
										No work recaps for this day.
									</p>
								{/if}
								{#if day.truncated}
									<p role="status" class="text-sm text-muted-foreground">
										This day's notes are longer than the app reads, so the end is cut off.
									</p>
								{/if}
							</section>
						</div>
					{:else if tabValue === 'runs'}
						<div class="px-4 pt-4 pb-12">
							<section aria-labelledby="{uid}-r" class="flex flex-col gap-1">
								<h2 id="{uid}-r" class="text-base font-semibold">Runs that day</h2>
								<p class="mb-2 text-sm text-muted-foreground">
									Each record is one chat response or task attempt. Open it to see the steps, result
									and evidence.
								</p>
								{#if day.runs.length}
									<ul class="flex flex-col">
										{#each day.runs as run (run.runId)}
											<li><RunRow {run} {now} href={runHref(run.runId)} /></li>
										{/each}
									</ul>
								{:else}
									<p class="text-sm text-muted-foreground">No runs started that day.</p>
								{/if}
							</section>
						</div>
					{/if}
				{/snippet}
			</SwipeableTabs>
		</div>
	{/if}
</DetailScreen>
