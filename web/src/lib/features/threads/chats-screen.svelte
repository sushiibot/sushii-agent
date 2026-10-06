<script lang="ts">
	import Archive from '@lucide/svelte/icons/archive';
	import Plus from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import UpdateToast from '$lib/ui/pwa/update-toast.svelte';
	import ListScreen, { type ListSection } from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import { status } from '$lib/ui/status/status';
	import ThreadRow from './components/thread-row.svelte';
	import type { ChatsData, ThreadState, ThreadSummary } from './types';

	let {
		remote,
		data,
		now,
		query = $bindable(''),
		online = true,
		updateReady = false,
		mainHref = '/chat',
		threadHref = (id) => `/chats/${id}`,
		onretry,
		onnew,
		onoptions,
		onreload
	}: {
		remote: RemoteLike;
		data?: ChatsData;
		now: number;
		query?: string;
		online?: boolean;
		updateReady?: boolean;
		mainHref?: string;
		threadHref?: (id: string) => string;
		onretry?: () => void;
		/** Starts a thread from scratch. */
		onnew?: () => void;
		onoptions?: (thread: ThreadSummary) => void;
		onreload?: () => void;
	} = $props();

	const threads = $derived(
		[...(data?.threads ?? [])].sort(
			(a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity)
		)
	);
	const q = $derived(query.trim().toLowerCase());
	const active = $derived(threads.filter((t) => t.state !== 'archived'));
	const archived = $derived(threads.filter((t) => t.state === 'archived'));

	const groups: [ThreadState, string][] = [
		['needs-you', 'Needs you'],
		['running', 'Running'],
		['idle', 'Recent']
	];
	const sections = $derived.by((): ListSection<ThreadSummary>[] => {
		if (q) {
			const hits = threads.filter(
				(t) => t.title.toLowerCase().includes(q) || t.preview.toLowerCase().includes(q)
			);
			return [{ label: `${hits.length} matching`, items: hits }];
		}
		return [
			...groups.map(([state, label]) => ({
				label,
				icon: state === 'needs-you' ? status.waiting.icon : undefined,
				iconClass: 'text-waiting',
				items: active.filter((t) => t.state === state)
			})),
			{ label: 'Archived', icon: Archive, count: true, items: archived }
		];
	});
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline', savedThreads: true }} />{/if}
{/snippet}
{#snippet toast()}<UpdateToast onreload={() => onreload?.()} />{/snippet}

{#snippet actions()}
	{#if onnew}
		<Button variant="ghost" size="lg" onclick={onnew}><Plus />New conversation</Button>
	{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [0, 1, 2, 3] as i (i)}
			<div class="flex items-center gap-3 px-2 py-2.5">
				<Skeleton class="size-10 rounded-lg" />
				<div class="flex flex-1 flex-col gap-2">
					<Skeleton class="h-4 w-1/2" />
					<Skeleton class="h-3 w-4/5" />
				</div>
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading conversations…</p>
{/snippet}

{#snippet lead()}
	{#if data && !q}
		<section aria-label="Chat" class="rounded-xl border bg-card px-1 py-1">
			<ThreadRow main={data.main} href={mainHref} {now} />
			<p class="px-3 pb-2 text-meta text-muted-foreground">
				Your general-purpose conversation. Return to a conversation for its topic.
			</p>
		</section>
	{/if}
{/snippet}

{#snippet row(t: ThreadSummary)}
	<ThreadRow
		thread={t}
		href={threadHref(t.id)}
		{now}
		onoptions={onoptions ? () => onoptions?.(t) : undefined}
	/>
{/snippet}

{#snippet after()}
	{#if data && !q}
		<p class="px-1 text-meta text-muted-foreground">
			Inactive conversations move below into Archived after {data.archiveAfterDays} days. Send a message
			to resume any conversation. History stays available.
		</p>
	{/if}
{/snippet}

<ListScreen
	title="Conversations"
	{banner}
	{actions}
	toast={updateReady ? toast : undefined}
	bind:search={query}
	searchLabel="Search conversations"
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load your conversations.",
		onretry,
		skeleton,
		empty: q
			? {
					title: 'No conversations match',
					body: `No conversation mentions “${query.trim()}”.`
				}
			: {
					title: 'No conversations yet',
					body: 'Main is above. When a topic keeps coming back, start a conversation from a reply in Main, or here.',
					...(onnew ? { action: { label: 'Start a conversation', onclick: onnew } } : {})
				}
	}}
	{sections}
	isEmpty={q ? sections[0].items.length === 0 : threads.length === 0}
	key={(t) => t.id}
	{lead}
	{row}
	{after}
/>
