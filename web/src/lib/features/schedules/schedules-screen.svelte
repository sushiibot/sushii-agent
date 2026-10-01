<script lang="ts">
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import ListScreen, { type ListSection } from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import { status } from '$lib/ui/status/status';
	import JobRow from './components/job-row.svelte';
	import type { Job } from './types';

	let {
		remote,
		jobs,
		now,
		back,
		online = true,
		jobHref = (id) => `/schedules/${id}`,
		onretry
	}: {
		remote: RemoteLike;
		jobs: Job[];
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		jobHref?: (id: string) => string;
		onretry?: () => void;
	} = $props();

	// A failed last run is the one thing here that needs you, so it leads.
	const sections = $derived<ListSection<Job>[]>([
		{
			label: 'Last run failed',
			icon: status.failed.icon,
			iconClass: 'text-failed',
			count: true,
			items: jobs.filter((j) => j.enabled && j.last?.result === 'failed')
		},
		{
			label: 'On',
			count: true,
			items: jobs.filter((j) => j.enabled && j.last?.result !== 'failed')
		},
		{ label: 'Paused', count: true, items: jobs.filter((j) => !j.enabled) }
	]);
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [0, 1, 2] as i (i)}
			<div class="flex flex-col gap-2 px-2 py-3">
				<Skeleton class="h-4 w-1/2" />
				<Skeleton class="h-3 w-3/4" />
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading schedules…</p>
{/snippet}

{#snippet row(job: Job)}
	<JobRow {job} {now} href={jobHref(job.id)} />
{/snippet}

<ListScreen
	title="Schedules"
	{back}
	{banner}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load schedules.",
		onretry,
		skeleton,
		empty: {
			title: 'No scheduled jobs',
			body: 'Ask the agent in chat to do something on a schedule, like a morning briefing, and the job shows up here.'
		}
	}}
	{sections}
	key={(j) => j.id}
	{row}
/>
