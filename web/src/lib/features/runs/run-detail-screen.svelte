<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileText from '@lucide/svelte/icons/file-text';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago, clock, duration } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import * as Tabs from '$lib/ui/tabs';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import Evidence from './components/evidence.svelte';
	import RunRow from './components/run-row.svelte';
	import StepRow from './components/step-row.svelte';
	import { kindLabel } from './format';
	import type { RunDetail, RunStep } from './types';

	let {
		remote,
		detail,
		steps = detail?.steps ?? [],
		now,
		back,
		hasMore = false,
		moreLoading = false,
		moreError = null,
		online = true,
		openSteps = [],
		runHref = (id) => `/runs/${id}`,
		historyHref = (date) => `/history/${date}`,
		onretry,
		onloadmore
	}: {
		remote: RemoteLike;
		/** null: there is no such run. */
		detail: RunDetail | null | undefined;
		/** Every step loaded so far, first page included. */
		steps?: RunStep[];
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		hasMore?: boolean;
		moreLoading?: boolean;
		moreError?: string | null;
		online?: boolean;
		/** Step ids to start expanded. */
		openSteps?: string[];
		runHref?: (runId: string) => string;
		historyHref?: (date: string) => string;
		onretry?: () => void;
		onloadmore?: () => void;
	} = $props();

	const uid = $props.id();
	let section = $state('overview');
	let fullTitle = $state(false);
	let shownRun = $state<string>();
	$effect(() => {
		if (run?.runId !== shownRun) {
			shownRun = run?.runId;
			fullTitle = false;
			section = openSteps.length ? 'timeline' : 'overview';
		}
	});
	const run = $derived(detail?.run);
	const outcome = $derived.by(() => {
		if (!run) return '';
		switch (run.status) {
			case 'running':
				return 'Still running. Open Timeline for the steps so far; this page refreshes when you come back to it.';
			case 'done':
				return 'Finished. That means it ran to the end, not that it worked: check the evidence.';
			case 'failed':
				return 'Failed. The host recorded an error before the run could finish.';
			case 'timeout':
				return 'Timed out. The host stopped it before it finished.';
			case 'aborted':
				return 'Stopped before it finished.';
		}
	});
	const sessionNote = $derived(
		detail?.session === 'missing'
			? "This run's transcript is gone, so there are no steps to show."
			: detail?.session === 'outside'
				? "This run's transcript is outside the agent's folders, so it wasn't read."
				: detail?.session === 'not-session'
					? "This run didn't happen in a session, so it has no steps."
					: null
	);
	const facts = $derived.by((): [string, string][] => {
		if (!run) return [];
		const started = Date.parse(run.startedAt);
		const rows: [string, string][] = [
			[
				'Started',
				`${ago(run.startedAt, now)}${ago(run.startedAt, now).includes(':') ? '' : ` · ${clock(started)}`}`
			],
			run.endedAt
				? ['Took', duration(Date.parse(run.endedAt) - started)]
				: ['Running for', duration(now - started)]
		];
		if (run.usage?.model) rows.push(['Model', run.usage.model]);
		if (run.usage) {
			rows.push([
				'Tokens',
				`${run.usage.inputTokens.toLocaleString()} in · ${run.usage.outputTokens.toLocaleString()} out`
			]);
			if (run.usage.costUsd !== undefined) rows.push(['Cost', `$${run.usage.costUsd.toFixed(2)}`]);
		}
		return rows;
	});
	const day = $derived(
		detail?.historyFile
			?.match(/^(\d{4}-\d{2})\/(\d{2})-/)
			?.slice(1)
			.join('-')
	);
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-4 px-4 pt-5" aria-hidden="true">
		<Skeleton class="h-6 w-4/5" />
		<Skeleton class="h-4 w-1/3" />
		<Skeleton class="h-20 w-full rounded-xl" />
		{#each [0, 1, 2, 3] as i (i)}
			<Skeleton class="h-10 w-full" />
		{/each}
	</div>
	<p role="status" class="sr-only">Loading the run…</p>
{/snippet}

<DetailScreen
	title="Run"
	{back}
	{banner}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load this run.",
		onretry,
		skeleton,
		isEmpty: detail === null,
		empty: {
			title: 'Run not found',
			body: 'It may be older than the runs the agent keeps, or the link is wrong. Its day in History may still have notes.'
		}
	}}
>
	{#if detail && run}
		<article class="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-4 pb-12">
			<header class="flex flex-col gap-2">
				{#if run.title.length > 160}
					<button
						type="button"
						class="flex min-h-12 w-full items-start gap-2 text-left"
						aria-label={fullTitle ? 'Collapse run title' : 'Show full run title'}
						aria-expanded={fullTitle}
						onclick={() => (fullTitle = !fullTitle)}
					>
						<span
							class="min-w-0 flex-1 text-lg leading-snug font-semibold [overflow-wrap:anywhere]"
							class:line-clamp-3={!fullTitle}>{run.title}</span
						>
						<ChevronDown
							class="mt-1 size-4 shrink-0 transition-transform motion-reduce:transition-none {fullTitle
								? 'rotate-180'
								: ''}"
							aria-hidden="true"
						/>
					</button>
				{:else}
					<p class="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">{run.title}</p>
				{/if}
				<p class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<StatePill of={run.status} />
					<span>{kindLabel(run)}</span>
				</p>
			</header>

			<Tabs.Root bind:value={section} class="flex min-w-0 flex-col gap-5">
				<Tabs.List
					aria-label="Run sections"
					class="sticky top-0 z-10 grid grid-cols-4 gap-2 border-b bg-background"
				>
					{#each ['Overview', 'Timeline', 'Evidence', 'Related'] as label (label)}
						<Tabs.Trigger
							value={label.toLowerCase()}
							class="min-h-12 min-w-12 border-b-2 border-transparent px-1 text-sm font-medium text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground"
							>{label}</Tabs.Trigger
						>
					{/each}
				</Tabs.List>
				<Tabs.Content value="overview" class="flex flex-col gap-5 data-[state=inactive]:hidden">
					<dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
						{#each facts as [k, v] (k)}
							<dt class="text-muted-foreground">{k}</dt>
							<dd class="min-w-0 [overflow-wrap:anywhere] tabular-nums">{v}</dd>
						{/each}
					</dl>
					<section
						aria-labelledby="{uid}-out"
						class="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3"
					>
						<h2 id="{uid}-out" class="text-sm font-medium text-muted-foreground">
							Outcome, as the host recorded it
						</h2>
						<p class="text-sm">{outcome}</p>
						{#if run.resultSummary}
							<p class="text-sm [overflow-wrap:anywhere]">
								<span class="text-muted-foreground">The agent noted:</span>
								{run.resultSummary}
							</p>
						{/if}
					</section>

					{#if day}
						<Button variant="outline" href={historyHref(day)} class="self-start">
							<FileText />Notes from that day<ArrowUpRight />
						</Button>
					{/if}
				</Tabs.Content>
				<Tabs.Content value="timeline" class="data-[state=inactive]:hidden">
					<section aria-labelledby="{uid}-tl" class="flex flex-col gap-2">
						<h2
							id="{uid}-tl"
							class="flex items-baseline justify-between gap-3 text-base font-semibold"
						>
							Timeline
							{#if steps.length}
								<span class="text-meta font-normal text-muted-foreground tabular-nums"
									>{steps.length}{hasMore ? '+' : ''} steps</span
								>
							{/if}
						</h2>
						{#if sessionNote}
							<p class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
								{sessionNote}
							</p>
						{:else if !steps.length}
							<p class="text-sm text-muted-foreground">No steps recorded yet.</p>
						{:else}
							<ol class="flex flex-col">
								{#each steps as step (step.id)}
									<li><StepRow {step} open={openSteps.includes(step.id)} /></li>
								{/each}
							</ol>
							{#if run.status === 'running' && !hasMore}
								<p role="status" class="flex items-center gap-2 px-2 text-sm text-muted-foreground">
									<LoaderCircle
										class="size-4 animate-spin motion-reduce:animate-none"
										aria-hidden="true"
									/>
									The agent is still working on this run.
								</p>
							{/if}
						{/if}
						{#if hasMore}
							<Button variant="outline" disabled={moreLoading} onclick={() => onloadmore?.()}>
								{#if moreLoading}
									<LoaderCircle
										class="animate-spin motion-reduce:animate-none"
										aria-hidden="true"
									/>Loading more steps…
								{:else}
									<ChevronDown />Show more steps
								{/if}
							</Button>
							{#if moreError}
								<p role="alert" class="text-sm text-failed">
									Couldn't load more steps. {moreError}
								</p>
							{/if}
						{/if}
					</section>
				</Tabs.Content>
				<Tabs.Content value="evidence" class="data-[state=inactive]:hidden">
					<Evidence evidence={detail.evidence} approvals={detail.approvals} files={detail.files} />
				</Tabs.Content>
				<Tabs.Content value="related" class="data-[state=inactive]:hidden">
					{#if detail.parent || detail.children.length}
						<section aria-labelledby="{uid}-rel" class="flex flex-col gap-1">
							<h2 id="{uid}-rel" class="text-sm font-medium text-muted-foreground">Related runs</h2>
							<ul class="flex flex-col">
								{#if detail.parent}
									<li class="flex flex-col">
										<span class="px-2 pt-1 text-meta text-muted-foreground">Started by</span>
										<RunRow run={detail.parent} {now} href={runHref(detail.parent.runId)} />
									</li>
								{/if}
								{#each detail.children as child (child.runId)}
									<li class="flex flex-col">
										<span class="px-2 pt-1 text-meta text-muted-foreground"
											>Started in the background</span
										>
										<RunRow run={child} {now} href={runHref(child.runId)} />
									</li>
								{/each}
							</ul>
						</section>
					{/if}

					{#if !detail.parent && !detail.children.length}
						<h2 class="text-base font-semibold">Related runs</h2>
						<p class="mt-2 text-sm text-muted-foreground">
							This run has no parent or background runs.
						</p>
					{/if}
				</Tabs.Content>
			</Tabs.Root>
		</article>
	{/if}
</DetailScreen>
