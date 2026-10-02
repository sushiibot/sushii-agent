<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FileText from '@lucide/svelte/icons/file-text';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago } from '$lib/ui/format/time';
	import TabbedScreen from '$lib/ui/screen/tabbed-screen.svelte';
	import ScreenState from '$lib/ui/screen/screen-state.svelte';
	import Search from '@lucide/svelte/icons/search';
	import { Input } from '$lib/ui/input';
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

	let category = $state('long-term');
	let search = $state('');
	const tabs = $derived([
		{ value: 'long-term', label: 'Long-term' },
		{ value: 'daily', label: 'Daily notes' },
		...(data?.writes.length ? [{ value: 'changes', label: 'Changes' }] : [])
	]);
	$effect(() => {
		if (!tabs.some((tab) => tab.value === category)) category = tabs[0].value;
	});
	const daily = (f: MemoryFileSummary) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(f.path);
	function itemsFor(value: string): Item[] {
		if (value === 'changes')
			return (data?.writes ?? []).slice(0, recent).map((w) => ({ kind: 'write', w }));
		return (data?.files ?? [])
			.filter(
				(f) =>
					(value === 'daily' ? daily(f) : !daily(f)) &&
					`${f.path} ${f.about}`.toLowerCase().includes(search.toLowerCase())
			)
			.sort((a, b) =>
				value === 'daily' ? b.path.localeCompare(a.path) : a.path.localeCompare(b.path)
			)
			.map((f) => ({ kind: 'file', f }));
	}
	const heading = (value: string) =>
		value === 'changes' ? 'Recent changes' : value === 'daily' ? 'Daily notes' : 'Long-term files';
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
	<div class="flex flex-col gap-3">
		<label class="relative block">
			<span class="sr-only">Find a memory file</span>
			<Search
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				type="search"
				bind:value={search}
				placeholder="Find a memory file"
				class="h-12 pl-9 text-base"
			/>
		</label>
		{#if data?.truncated}<p role="status" class="text-sm text-muted-foreground">
				Some files could not be shown in full because the memory browsing limit was reached.
			</p>{/if}
	</div>
{/snippet}

<TabbedScreen
	title="Memory"
	{back}
	{banner}
	{tabs}
	bind:value={category}
	label="Memory sections"
	{lead}
>
	{#snippet children(value)}
		{@const items = itemsFor(value)}
		<div class="flex flex-col gap-5">
			<p class="text-sm text-muted-foreground">
				{value === 'long-term'
					? 'Saved facts and preferences the agent keeps across conversations. Open a file to read its current contents.'
					: value === 'daily'
						? 'The agent’s memory notes for each day. Work recaps and run records live in History.'
						: 'Recent recorded changes to saved memory.'}
			</p>
			<ScreenState
				remote={data && remote.status === 'loading' ? { status: 'ready' } : remote}
				offline={!online}
				errorTitle="Couldn't load memory."
				{onretry}
				{skeleton}
				isEmpty={!items.length}
				empty={{
					title: 'Nothing remembered yet',
					body: search
						? 'No files match your search. Try another file name.'
						: value === 'daily'
							? 'Daily notes appear here when the agent saves them.'
							: 'Saved facts and preferences appear here when the agent remembers them.'
				}}
			>
				<section aria-label={heading(value)} class="flex flex-col gap-1">
					<h2 class="px-1 text-sm font-medium text-muted-foreground">{heading(value)}</h2>
					<ul class="flex flex-col">
						{#each items as item (item.kind === 'write' ? `w:${item.w.id}` : `f:${item.f.id}`)}<li
								class="min-h-12"
							>
								{@render row(item)}
							</li>{/each}
					</ul>
				</section>
				{#if value === 'changes' && data && data.writes.length > recent}<a
						href={writesHref}
						class="flex h-12 items-center justify-center rounded-md border text-sm font-medium hover:bg-muted"
						>All {data.writes.length} changes</a
					>{/if}
			</ScreenState>
		</div>
	{/snippet}
</TabbedScreen>
