<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FileText from '@lucide/svelte/icons/file-text';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago } from '$lib/ui/format/time';
	import ListScreen, { type ListSection } from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import WriteRow from './components/write-row.svelte';
	import type { MemoryFileSummary, MemoryOverview, MemoryWriteRecord } from './types';

	type Item = { kind: 'write'; w: MemoryWriteRecord } | { kind: 'file'; f: MemoryFileSummary };

	let {
		remote,
		data,
		now,
		back,
		online = true,
		recent = 3,
		writeHref = (id) => `/memory/writes/${id}`,
		fileHref = (id) => `/memory/files/${id}`,
		writesHref = '/memory/writes',
		onretry
	}: {
		remote: RemoteLike;
		data?: MemoryOverview;
		now: number;
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		/** How many of the newest changes show above the files. */
		recent?: number;
		writeHref?: (id: string) => string;
		fileHref?: (id: string) => string;
		writesHref?: string;
		onretry?: () => void;
	} = $props();

	let category = $state<'long-term' | 'daily' | 'changes'>('long-term');
	let search = $state('');
	const daily = (f: MemoryFileSummary) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(f.path);
	const sections = $derived.by((): ListSection<Item>[] => {
		if (category === 'changes')
			return [
				{
					label: 'Recent changes',
					items: (data?.writes ?? []).slice(0, recent).map((w) => ({ kind: 'write', w }))
				}
			];
		const files = (data?.files ?? []).filter(
			(f) =>
				(category === 'daily' ? daily(f) : !daily(f)) &&
				`${f.path} ${f.about}`.toLowerCase().includes(search.toLowerCase())
		);
		files.sort((a, b) =>
			category === 'daily' ? b.path.localeCompare(a.path) : a.path.localeCompare(b.path)
		);
		return [
			{
				label: category === 'daily' ? 'Daily notes' : 'Long-term files',
				items: files.map((f) => ({ kind: 'file', f }))
			}
		];
	});
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="flex flex-col gap-2 px-2 py-3">
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="h-3 w-1/2" />
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading memory…</p>
{/snippet}

{#snippet row(item: Item)}
	{#if item.kind === 'write'}
		<WriteRow write={item.w} {now} href={writeHref(item.w.id)} />
	{:else}
		<a
			href={fileHref(item.f.id)}
			class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
		>
			<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
				<FileText class="size-4.5" aria-hidden="true" />
			</span>
			<span class="flex min-w-0 flex-1 flex-col gap-0.5">
				<span class="font-mono text-ui font-medium [overflow-wrap:anywhere]">{item.f.path}</span>
				<span class="text-sm text-muted-foreground">{item.f.about}</span>
				<span class="text-meta text-muted-foreground tabular-nums"
					>{item.f.lines} lines · changed {ago(item.f.updatedAt, now)}</span
				>
			</span>
			<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		</a>
	{/if}
{/snippet}

{#snippet lead()}
	<div class="sticky top-0 z-10 flex flex-col gap-3 bg-background pb-3">
		<div class="flex gap-2" aria-label="Memory sections">
			{#each [{ id: 'long-term' as const, label: 'Long-term' }, { id: 'daily' as const, label: 'Daily notes' }, ...(data?.writes.length ? [{ id: 'changes' as const, label: 'Changes' }] : [])] as tab (tab.id)}
				<button
					class="min-h-12 flex-1 rounded-md px-3 text-ui font-medium hover:bg-muted"
					class:bg-muted={category === tab.id}
					aria-pressed={category === tab.id}
					onclick={() => (category = tab.id)}>{tab.label}</button
				>
			{/each}
		</div>
		<p class="text-sm text-muted-foreground">
			{category === 'long-term'
				? 'Saved facts and preferences the agent keeps across conversations. Open a file to read its current contents.'
				: category === 'daily'
					? 'The agent’s memory notes for each day. Work recaps and run records live in History.'
					: 'Recent recorded changes to saved memory.'}
		</p>
		{#if data?.truncated}<p role="status" class="text-sm text-muted-foreground">
				Some files could not be shown in full because the memory browsing limit was reached.
			</p>{/if}
	</div>
{/snippet}

{#snippet after()}
	{#if category === 'changes' && data && data.writes.length > recent}
		<a
			href={writesHref}
			class="flex h-12 items-center justify-center rounded-md border text-sm font-medium hover:bg-muted"
			>All {data.writes.length} changes</a
		>
	{/if}
{/snippet}

<ListScreen
	title="Memory"
	{back}
	{banner}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load memory.",
		onretry,
		skeleton,
		empty: {
			title: 'Nothing remembered yet',
			body: search
				? 'No files match your search. Try another file name.'
				: category === 'daily'
					? 'Daily notes appear here when the agent saves them.'
					: 'Saved facts and preferences appear here when the agent remembers them.'
		}
	}}
	{sections}
	{lead}
	bind:search
	searchLabel="Find a memory file"
	key={(i) => (i.kind === 'write' ? `w:${i.w.id}` : `f:${i.f.id}`)}
	{row}
	{after}
/>
