<script lang="ts">
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import ConnectionBanner, { type ConnectionState } from '$lib/ui/connection-banner.svelte';
	import UpdateToast from '$lib/ui/pwa/update-toast.svelte';
	import { Button } from '$lib/ui/button';
	import ListScreen, { type ListSection } from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import { status } from '$lib/ui/status/status';
	import HomeRow from './components/home-row.svelte';
	import Peek from './components/peek.svelte';
	import { peekTitle } from './format';
	import type { HomeData, HomeGroup, HomeGroups, HomeItem, HomePeek } from './types';

	let {
		groups,
		remote,
		partError = null,
		partLoading = false,
		workspace = 'online',
		connection,
		now,
		peek,
		updateReady = false,
		onopen,
		onclose,
		onretry,
		ondecide,
		onanswer,
		ondismiss,
		onopenrun,
		onaskagent,
		onopenchat,
		onreload
	}: {
		groups: HomeGroups;
		/** Loading until the stream greets or the server part arrives. */
		remote: RemoteLike;
		/** The server part failed while the stream part is fine. */
		partError?: string | null;
		/** The server part is still on its way, slowly. */
		partLoading?: boolean;
		workspace?: HomeData['workspace']['state'];
		connection?: ConnectionState | 'forbidden';
		now: number;
		/** The open peek sheet; leave out when closed. */
		peek?: HomePeek;
		updateReady?: boolean;
		onopen?: (id: string) => void;
		onclose?: () => void;
		onretry?: () => void;
		ondecide?: (nonce: string, decision: 'approve' | 'deny') => void;
		onanswer?: (askId: string, answer: string, index?: number) => void;
		ondismiss?: (id: string) => void;
		onopenrun?: (runId: string) => void;
		onaskagent?: (item: HomeItem) => void;
		onopenchat?: () => void;
		onreload?: () => void;
	} = $props();

	const order: HomeGroup[] = ['waiting', 'failed', 'running', 'review'];
	const iconTone: Record<HomeGroup, string> = {
		waiting: 'text-waiting',
		failed: 'text-failed',
		running: 'text-running',
		review: 'text-review'
	};
	const sections = $derived(
		order.map((g): ListSection<HomeItem> => ({
			label: status[g].label,
			icon: status[g].icon,
			iconClass: iconTone[g],
			count: true,
			items: groups[g]
		}))
	);
	const total = $derived(order.reduce((n, g) => n + groups[g].length, 0));
	const workspaceNote = $derived(
		partError
			? null
			: workspace === 'offline'
				? "Can't reach the agent, so running and failed work may be missing."
				: workspace === 'timeout'
					? 'The agent took too long to answer, so running and failed work may be missing.'
					: workspace === 'unsupported'
						? "Running and failed work aren't available yet."
						: null
	);
	// Keeps the closing sheet's content while it slides away.
	let kept = $state<HomePeek>();
	$effect.pre(() => {
		if (peek) kept = peek;
	});
	const shownPeek = $derived(peek ?? kept);
</script>

{#snippet banner()}
	{#if connection}<ConnectionBanner state={connection} />{/if}
{/snippet}
{#snippet toast()}<UpdateToast onreload={() => onreload?.()} />{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		<Skeleton class="h-4 w-32" />
		{#each [0, 1, 2] as i (i)}
			<div class="flex gap-3 px-2 py-2.5">
				<Skeleton class="size-8 rounded-full" />
				<div class="flex flex-1 flex-col gap-2">
					<Skeleton class="h-4 w-3/4" />
					<Skeleton class="h-3 w-1/2" />
				</div>
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading what needs you…</p>
{/snippet}

{#snippet row(item: HomeItem)}
	<HomeRow {item} {now} selected={peek?.id === item.id} {onopen} />
{/snippet}

{#snippet after()}
	{#if partLoading}
		<p role="status" class="flex items-center gap-2 px-1 text-sm text-muted-foreground">
			<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
			Loading failed and running work…
		</p>
	{:else if partError}
		<div role="alert" class="flex flex-col items-start gap-3 rounded-xl border px-4 py-3">
			<p class="text-sm">
				<span class="font-medium">Couldn't load failed and running work.</span>
				{partError}
			</p>
			<Button variant="outline" onclick={() => onretry?.()}><RotateCcw />Try again</Button>
		</div>
	{:else if workspaceNote}
		<p role="status" class="flex items-start gap-2 rounded-xl border px-4 py-3 text-sm">
			<CloudOff class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			{workspaceNote}
		</p>
	{/if}
{/snippet}

<ListScreen
	title="Home"
	{banner}
	toast={updateReady ? toast : undefined}
	state={{
		remote,
		offline:
			connection !== undefined && connection !== 'forbidden' && connection.kind === 'app-offline',
		errorTitle: "Couldn't load Home.",
		onretry,
		skeleton,
		empty: {
			title: 'Nothing needs you',
			body: 'Approvals, questions and failed runs show up here when the agent needs you.',
			action: onopenchat ? { label: 'Open chat', onclick: onopenchat } : undefined
		}
	}}
	{sections}
	isEmpty={total === 0 && !partError && !partLoading && !workspaceNote}
	key={(item) => item.id}
	{row}
	{after}
/>

<RoutedSheet
	open={!!peek}
	label={shownPeek ? peekTitle(shownPeek) : ''}
	onclose={() => onclose?.()}
>
	{#if shownPeek}
		<Peek
			peek={shownPeek}
			{now}
			{onclose}
			{ondecide}
			{onanswer}
			{ondismiss}
			{onopenrun}
			{onopenchat}
			{onaskagent}
		/>
	{/if}
</RoutedSheet>
