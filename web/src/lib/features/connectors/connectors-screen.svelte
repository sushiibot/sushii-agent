<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Plus from '@lucide/svelte/icons/plus';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import ListScreen from '$lib/ui/screen/list-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { McpServerSummary } from './types';

	let {
		remote,
		servers,
		back,
		online = true,
		serverHref = (id) => `/connectors/${id}`,
		addHref = '/connectors/add',
		onretry
	}: {
		remote: RemoteLike;
		servers: McpServerSummary[];
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		serverHref?: (id: string) => string;
		addHref?: string;
		onretry?: () => void;
	} = $props();

	const sections = $derived([
		{
			label: 'Needs attention',
			items: servers.filter((s) => s.status !== 'connected')
		},
		{ label: 'Connected', items: servers.filter((s) => s.status === 'connected') }
	]);
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3" aria-hidden="true">
		{#each [0, 1, 2] as i (i)}
			<div class="flex items-center gap-3 px-2 py-3">
				<Skeleton class="size-9 rounded-lg" />
				<div class="flex flex-1 flex-col gap-2">
					<Skeleton class="h-4 w-1/3" />
					<Skeleton class="h-3 w-2/3" />
				</div>
			</div>
		{/each}
	</div>
	<p role="status" class="sr-only">Loading connectors…</p>
{/snippet}

{#snippet row(s: McpServerSummary)}
	<a
		href={serverHref(s.id)}
		class="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-muted/60"
	>
		<span
			class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-sm font-semibold"
			aria-hidden="true">{s.name[0]}</span
		>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="flex flex-wrap items-center gap-2">
				<span class="text-ui font-medium">{s.name}</span>
				{#if s.status === 'error'}<StatePill of="failed" label="Not working" />
				{:else if s.status === 'signed-out'}<StatePill of="waiting" label="Sign in again" />
				{:else if s.changed}<StatePill of="quiet" label="Tools changed" />{/if}
			</span>
			<span class="font-mono text-meta [overflow-wrap:anywhere] text-muted-foreground">{s.url}</span
			>
			<span class="text-meta text-muted-foreground tabular-nums">{s.tools} tools</span>
		</span>
		<ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	</a>
{/snippet}

{#snippet footer()}
	<div class="border-t px-4 py-3">
		<a
			href={addHref}
			class="flex h-12 items-center justify-center gap-2 rounded-lg bg-primary text-body font-semibold text-primary-foreground hover:bg-primary/90"
			><Plus class="size-4" aria-hidden="true" />Add a server by URL</a
		>
	</div>
{/snippet}

<ListScreen
	title="Connectors"
	{back}
	{banner}
	{footer}
	state={{
		remote,
		offline: !online,
		errorTitle: "Couldn't load connectors.",
		onretry,
		skeleton,
		empty: {
			title: 'No servers yet',
			body: 'An MCP server gives the agent tools, like your mail or calendar. Add one with its address.'
		}
	}}
	{sections}
	key={(s) => s.id}
	{row}
/>
