<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import { SwitchRow } from '$lib/ui/switch';
	import { nextRunLine } from './format';
	import type { JobDetail, TestRun } from './types';

	let {
		remote,
		job,
		now,
		back,
		online = true,
		busy = false,
		error = null,
		test,
		runHref = (id) => `/runs/${id}`,
		ontoggle,
		ontest,
		onretry
	}: {
		remote: RemoteLike;
		/** null: no such job. */
		job?: JobDetail | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		busy?: boolean;
		error?: string | null;
		test?: TestRun;
		runHref?: (id: string) => string;
		ontoggle?: (enabled: boolean) => void;
		ontest?: () => void;
		onretry?: () => void;
	} = $props();
	const uid = $props.id();
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-6 w-1/2" />
		<Skeleton class="h-12 w-full rounded-xl" />
		<Skeleton class="h-24 w-full rounded-xl" />
	</div>
	<p role="status" class="sr-only">Loading the job…</p>
{/snippet}

{#snippet footer()}
	{#if job}
		<div class="flex flex-col gap-2 border-t px-4 py-3">
			{#if test}
				<div role="status" class="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm">
					{#if test.state === 'running'}
						<p class="flex items-center gap-2 text-running">
							<LoaderCircle
								class="size-4 shrink-0 animate-spin motion-reduce:animate-none"
								aria-hidden="true"
							/>{test.step}…
						</p>
					{:else if test.state === 'done'}
						<span class="flex flex-wrap items-center gap-2"
							><span class="font-medium">Test run</span><StatePill of={test.result} /></span
						>
						<p class="text-muted-foreground">{test.note}</p>
					{:else}
						<p class="text-failed">The test run didn't start. {test.note}</p>
					{/if}
				</div>
			{/if}
			<Button
				size="lg"
				variant="outline"
				disabled={test?.state === 'running' || !online}
				onclick={ontest}
			>
				<FlaskConical />{test && test.state !== 'running' ? 'Test again' : 'Test run'}
			</Button>
			<p class="text-center text-meta text-muted-foreground">
				{online
					? 'Runs it now with sending turned off.'
					: "You're offline. A test run needs the agent."}
			</p>
		</div>
	{/if}
{/snippet}

<DetailScreen
	title={job?.name ?? 'Job'}
	{back}
	{banner}
	footer={job ? footer : undefined}
	state={{
		remote: job === null ? { status: 'ready' } : remote,
		isEmpty: job === null,
		empty: { title: 'No such job', body: 'It may have been deleted in chat.' },
		offline: !online,
		errorTitle: "Couldn't load this job.",
		onretry,
		skeleton
	}}
>
	{#if job}
		<div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-4">
			<header class="flex flex-col gap-1">
				<p class="text-sm font-medium">{job.schedule}</p>
				<p class="text-sm text-muted-foreground tabular-nums">{nextRunLine(job, now)}</p>
			</header>
			<div class="rounded-xl border">
				<SwitchRow checked={job.enabled} disabled={busy || !online} onchange={(v) => ontoggle?.(v)}>
					<span class="text-ui font-medium">Runs on its schedule</span>
					<span class="text-sm text-muted-foreground"
						>{job.enabled ? 'On.' : 'Paused. It won’t run until you turn it on.'}</span
					>
				</SwitchRow>
			</div>
			{#if error}<p role="alert" class="text-sm text-failed">Couldn't change it. {error}</p>{/if}
			<section aria-labelledby="{uid}-p" class="flex flex-col gap-1">
				<h2 id="{uid}-p" class="text-sm font-semibold">What it asks the agent</h2>
				<p class="rounded-xl bg-muted px-3 py-2.5 text-sm [overflow-wrap:anywhere]">{job.prompt}</p>
			</section>
			<section aria-labelledby="{uid}-runs" class="flex flex-col gap-2">
				<h2 id="{uid}-runs" class="text-sm font-semibold">Recent runs</h2>
				{#if job.runs.length}
					<ol class="flex flex-col divide-y rounded-xl border text-sm">
						{#each job.runs as r (r.at)}
							<li>
								{#if r.runId}
									<a
										href={runHref(r.runId)}
										class="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-muted/60"
									>
										{@render runLine(r)}
										<ArrowUpRight
											class="size-3.5 shrink-0 text-muted-foreground"
											aria-hidden="true"
										/>
									</a>
								{:else}
									<div class="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
										{@render runLine(r)}
									</div>
								{/if}
							</li>
						{/each}
					</ol>
				{:else}
					<p class="text-sm text-muted-foreground">It hasn't run yet.</p>
				{/if}
			</section>
		</div>
	{/if}
</DetailScreen>

{#snippet runLine(r: JobDetail['runs'][number])}
	<span class="w-28 shrink-0 text-muted-foreground tabular-nums">{ago(r.at, now)}</span>
	<StatePill of={r.result} />
	<span class="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere] text-muted-foreground"
		>{r.note}</span
	>
{/snippet}
