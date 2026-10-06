<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileText from '@lucide/svelte/icons/file-text';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago, clock, duration } from '$lib/ui/format/time';
	import TabbedScreen from '$lib/ui/screen/tabbed-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import Evidence from './components/evidence.svelte';
	import RunRow from './components/run-row.svelte';
	import StepRow from './components/step-row.svelte';
	import { kindLabel, activityTitle } from './format';
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
		conversationHref,
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
		conversationHref?: (conversationId: string) => string | undefined;
		onretry?: () => void;
		onloadmore?: () => void;
	} = $props();

	const uid = $props.id();
	let section = $state('timeline');
	let shownRun = $state<string>();
	$effect(() => {
		if (run?.runId !== shownRun) {
			shownRun = run?.runId;
			section = 'timeline';
		}
	});
	const run = $derived(detail?.run);
	const activeChildren = $derived(
		detail?.children.filter((child) => child.status === 'running').length ?? 0
	);
	const conversationId = $derived(
		run?.conversationId ??
			detail?.parent?.conversationId ??
			(run?.kind === 'chat' || detail?.parent?.kind === 'chat' ? 'main' : undefined)
	);
	const chatHref = $derived(conversationId ? conversationHref?.(conversationId) : undefined);
	const outcome = $derived.by(() => {
		if (!run) return '';
		switch (run.status) {
			case 'running':
				return 'Still running. Follow the steps in Activity.';
			case 'done':
				return 'Execution finished. Review the result and recorded checks below.';
			case 'failed':
				return 'Failed. An error ended this attempt before it finished.';
			case 'timeout':
				return 'Timed out. The host stopped it before it finished.';
			case 'aborted':
				return 'Stopped before it finished.';
		}
	});
	const sessionNote = $derived(
		detail?.session === 'missing'
			? 'The transcript is gone, so there are no steps to show.'
			: detail?.session === 'outside'
				? "The transcript is outside the agent's folders, so it wasn't read."
				: detail?.session === 'not-session'
					? 'No transcript was recorded for this system event.'
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
	<div class="flex flex-col gap-4" aria-hidden="true">
		<Skeleton class="h-6 w-4/5" />
		<Skeleton class="h-4 w-1/3" />
		{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-10 w-full" />{/each}
	</div>
	<p role="status" class="sr-only">Loading activity…</p>
{/snippet}

<TabbedScreen
	wide
	hasContent={!!detail}
	title={run?.kind === 'chat'
		? 'Reply activity'
		: run?.kind === 'flush' || run?.kind === 'rotate'
			? 'System activity'
			: 'Task'}
	{back}
	{banner}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load this activity.",
		onretry,
		skeleton,
		isEmpty: detail === null,
		empty: {
			title: 'Activity not found',
			body: 'The record may no longer be available, or the link is wrong. History may still have notes.'
		}
	}}
	tabs={[
		{ value: 'timeline', label: 'Activity' },
		{ value: 'evidence', label: 'Results' },
		{ value: 'overview', label: 'Details' }
	]}
	bind:value={section}
	label="Activity sections"
>
	{#snippet lead()}
		{#if detail && run}
			<div class="flex flex-col gap-2">
				{#if run.kind !== 'chat'}<p
						class="text-lg leading-snug font-semibold [overflow-wrap:anywhere]"
					>
						{activityTitle(run)}
					</p>{/if}
				<p class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<StatePill of={run.status} label={run.status === 'done' ? 'Finished' : undefined} />
					<span>{kindLabel(run)}{run.repo ? ` · ${run.repo}` : ''}</span>
				</p>
				{#if activeChildren && run.status !== 'running'}
					<p role="status" class="text-sm text-muted-foreground">
						{activeChildren} delegated {activeChildren === 1 ? 'task is' : 'tasks are'} still running.
					</p>
				{/if}
				{#if chatHref || detail.parent || detail.children.length}
					<div class="flex flex-wrap gap-x-3">
						{#if chatHref}<Button variant="link" href={chatHref} class="px-0"
								>Open conversation<ArrowUpRight /></Button
							>{/if}
						{#if detail.children.length}<Button
								variant="link"
								class="px-0"
								onclick={() => (section = 'overview')}
								>Delegated tasks · {detail.children.length}<ChevronDown /></Button
							>
						{:else if detail.parent}<Button
								variant="link"
								class="px-0"
								href={runHref(detail.parent.runId)}
								>Parent {detail.parent.kind === 'chat' ? 'reply' : 'task'}<ArrowUpRight /></Button
							>{/if}
					</div>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet children(tabValue)}
		{#if detail && run}
			{#if tabValue === 'timeline'}
				<section aria-labelledby="{uid}-tl" class="flex flex-col gap-3">
					<h2
						id="{uid}-tl"
						class="flex items-baseline justify-between gap-3 text-base font-semibold"
					>
						Activity
						{#if steps.length}<span class="text-meta font-normal text-muted-foreground tabular-nums"
								>{steps.length}{hasMore ? '+' : ''} steps</span
							>{/if}
					</h2>
					<p class="text-meta text-muted-foreground">
						Oldest first · tool details expand in place.
					</p>
					{#if run.kind === 'chat'}<p class="text-sm text-muted-foreground">
							One reply cycle within your conversation, including tools and follow-up instructions.
						</p>{/if}
					{#if sessionNote}<p class="text-sm text-muted-foreground">{sessionNote}</p>
					{:else if !steps.length}<p class="text-sm text-muted-foreground">
							No steps recorded yet.
						</p>
					{:else}
						<ol class="flex flex-col" data-run-activity>
							{#each steps as step (step.id)}<li>
									<StepRow {step} open={openSteps.includes(step.id)} />
								</li>{/each}
						</ol>
					{/if}
					{#if hasMore}
						<Button
							variant="outline"
							class="self-start"
							disabled={moreLoading}
							onclick={() => onloadmore?.()}
						>
							{#if moreLoading}<LoaderCircle
									class="animate-spin motion-reduce:animate-none"
									aria-hidden="true"
								/>Loading more steps…
							{:else}<ChevronDown />Show more steps{/if}
						</Button>
						{#if moreError}<p role="alert" class="text-sm text-failed">
								Couldn't load more steps. {moreError}
							</p>{/if}
					{/if}
				</section>
			{:else if tabValue === 'evidence'}
				<div class="flex flex-col gap-6">
					<section aria-labelledby="{uid}-out" class="flex flex-col gap-2">
						<h2 id="{uid}-out" class="text-base font-semibold">Result</h2>
						<p class="text-sm">{outcome}</p>
						{#if run.resultSummary}<p
								class="text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap"
							>
								{run.resultSummary}
							</p>{/if}
						{#if detail.children.some((child) => child.status === 'running')}<p
								class="text-sm text-muted-foreground"
							>
								Delegated work is still running. Open Details to follow each task.
							</p>{/if}
					</section>
					<Evidence evidence={detail.evidence} approvals={detail.approvals} files={detail.files} />
				</div>
			{:else if tabValue === 'overview'}
				<div class="flex flex-col gap-6">
					<section aria-labelledby="{uid}-brief" class="flex flex-col gap-2">
						<h2 id="{uid}-brief" class="text-base font-semibold">
							{run.kind === 'chat'
								? 'Request'
								: run.kind === 'flush' || run.kind === 'rotate'
									? 'System event'
									: 'Task brief'}
						</h2>
						<p class="text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
							{steps.find((step) => step.type === 'user')?.text ?? run.title}
						</p>
					</section>
					{#if detail.parent || detail.children.length}
						<section aria-labelledby="{uid}-agents" class="flex flex-col gap-2">
							<h2 id="{uid}-agents" class="text-base font-semibold">Agents and delegation</h2>
							<ul class="flex flex-col">
								{#if detail.parent}<li class="flex flex-col">
										<span class="px-2 text-meta text-muted-foreground"
											>Parent {detail.parent.kind === 'chat' ? 'reply' : 'task'}</span
										><RunRow run={detail.parent} {now} href={runHref(detail.parent.runId)} />
									</li>{/if}
								{#each detail.children as child (child.runId)}<li class="flex flex-col">
										<span class="px-2 text-meta text-muted-foreground">Delegated task</span><RunRow
											run={child}
											{now}
											href={runHref(child.runId)}
										/>
									</li>{/each}
							</ul>
						</section>
					{/if}
					<section aria-labelledby="{uid}-execution" class="flex flex-col gap-2">
						<h2 id="{uid}-execution" class="text-base font-semibold">Execution details</h2>
						<p class="text-sm text-muted-foreground">
							This record covers one execution attempt. Follow-up replies remain in the
							conversation.
						</p>
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							{#each facts as [k, v] (k)}<dt class="text-muted-foreground">{k}</dt>
								<dd class="min-w-0 [overflow-wrap:anywhere] tabular-nums">{v}</dd>{/each}
							<dt class="text-muted-foreground">Run ID</dt>
							<dd class="min-w-0 font-mono text-code [overflow-wrap:anywhere]">{run.runId}</dd>
						</dl>
					</section>
					{#if day}<Button variant="outline" href={historyHref(day)} class="self-start"
							><FileText />Notes from that day<ArrowUpRight /></Button
						>{/if}
				</div>
			{/if}
		{/if}
	{/snippet}
</TabbedScreen>
