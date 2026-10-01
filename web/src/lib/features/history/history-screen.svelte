<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Search from '@lucide/svelte/icons/search';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { dayLabel, fromDate } from '$lib/ui/format/time';
	import ListScreen, { type ListSection } from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import type { HistoryDay } from './types';

	let {
		remote,
		days,
		now,
		back,
		hasOlder = false,
		olderLoading = false,
		olderError = null,
		online = true,
		dayHref = (date) => `/history/${date}`,
		searchHref = '/history/search',
		onretry,
		onloadolder
	}: {
		remote: RemoteLike;
		days: HistoryDay[];
		now: number;
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		hasOlder?: boolean;
		olderLoading?: boolean;
		olderError?: string | null;
		online?: boolean;
		dayHref?: (date: string) => string;
		searchHref?: string;
		onretry?: () => void;
		onloadolder?: () => void;
	} = $props();

	const sections = $derived.by(() => {
		const months = new Map<string, HistoryDay[]>();
		for (const day of days) {
			const key = day.date.slice(0, 7);
			months.set(key, [...(months.get(key) ?? []), day]);
		}
		return [...months.entries()].map(([key, items]): ListSection<HistoryDay> => ({
			label: new Date(fromDate(`${key}-01`)).toLocaleDateString(undefined, {
				month: 'long',
				year: 'numeric'
			}),
			items
		}));
	});
	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet lead()}
	<a
		href={searchHref}
		class="flex h-12 items-center gap-2.5 rounded-lg border border-input px-3 text-base text-muted-foreground hover:bg-muted/60 dark:bg-input/30"
	>
		<Search class="size-4 shrink-0" aria-hidden="true" />Search chat and notes
	</a>
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-2" aria-hidden="true">
		<Skeleton class="h-4 w-28" />
		{#each [0, 1, 2, 3, 4] as i (i)}
			<div class="flex flex-col gap-2 px-2 py-3">
				<Skeleton class="h-4 w-1/3" />
				<Skeleton class="h-3 w-1/2" />
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading history…</p>
{/snippet}

{#snippet row(day: HistoryDay)}
	<a
		href={dayHref(day.date)}
		class="flex min-h-14 items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-muted/60"
	>
		<span class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span class="text-ui font-medium">{dayLabel(fromDate(day.date), now)}</span>
			<span class="text-sm text-muted-foreground">
				{day.sessions || day.runs
					? [
							day.sessions && count(day.sessions, 'session', 'sessions'),
							day.runs && count(day.runs, 'run', 'runs')
						]
							.filter(Boolean)
							.join(' · ')
					: 'Nothing recorded'}
			</span>
		</span>
		<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	</a>
{/snippet}

{#snippet after()}
	{#if hasOlder}
		<Button variant="outline" disabled={olderLoading} onclick={() => onloadolder?.()}>
			{#if olderLoading}
				<LoaderCircle class="animate-spin motion-reduce:animate-none" aria-hidden="true" />Loading
				older days…
			{:else}
				<ChevronDown />Show older days
			{/if}
		</Button>
		{#if olderError}
			<p role="alert" class="text-sm text-failed">Couldn't load older days. {olderError}</p>
		{/if}
	{/if}
{/snippet}

<ListScreen
	title="History"
	{back}
	{banner}
	{lead}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load history.",
		onretry,
		skeleton,
		empty: {
			title: 'No notes yet',
			body: 'The agent writes a note for each day it works. They show up here, newest first.'
		}
	}}
	{sections}
	key={(d) => d.date}
	{row}
	{after}
/>
