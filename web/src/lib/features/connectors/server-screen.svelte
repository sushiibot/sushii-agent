<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import Check from '@lucide/svelte/icons/check';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Plug from '@lucide/svelte/icons/plug';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { ago } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import SwipeableTabs from '$lib/ui/tabs/swipeable-tabs.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import { cn } from '$lib/utils';
	import type { McpServer } from './types';

	let {
		remote,
		server,
		now,
		back,
		online = true,
		justConnected = false,
		busy = false,
		error = null,
		runHref = (id) => `/runs/${id}`,
		onaccept,
		onreconnect,
		ondisconnect,
		onremove,
		signInHref,
		onretry
	}: {
		remote: RemoteLike;
		/** null: no such server. */
		server?: McpServer | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		justConnected?: boolean;
		busy?: boolean;
		error?: string | null;
		runHref?: (id: string) => string;
		onreconnect?: () => void;
		ondisconnect?: () => void;
		onremove?: () => void;
		signInHref?: string;
		onaccept?: () => void;
		onretry?: () => void;
	} = $props();
	const uid = $props.id();
	const mark = { added: '+', removed: '−', changed: '~' };
	let removing = $state(false);
	let section = $state('tools');
	let shownServer = $state<string>();
	$effect(() => {
		if (server?.id !== shownServer) {
			shownServer = server?.id;
			section = 'tools';
			removing = false;
		}
	});
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-4 w-2/3" />
		<Skeleton class="h-40 w-full rounded-xl" />
	</div>
	<p role="status" class="sr-only">Loading the server…</p>
{/snippet}

{#snippet footer()}
	{#if server?.changed}
		<div class="flex flex-col gap-2 border-t px-4 py-3">
			{#if error}<p role="alert" class="text-sm text-failed">Couldn't save it. {error}</p>{/if}
			<Button size="lg" variant="outline" disabled={busy || !online} onclick={onaccept}>
				{#if busy}<LoaderCircle
						class="animate-spin motion-reduce:animate-none"
						aria-hidden="true"
					/>Saving…{:else}<Check />Save tracking snapshot{/if}
			</Button>
			<p class="text-center text-meta text-muted-foreground">
				Optional: reset the tool comparison. Current tools are already available to the agent.
			</p>
		</div>
	{/if}
{/snippet}

<DetailScreen
	title={server?.name ?? 'Server'}
	{back}
	{banner}
	footer={server?.changed && section === 'tools' ? footer : undefined}
	state={{
		remote: server === null ? { status: 'ready' } : remote,
		isEmpty: server === null,
		empty: { title: 'No such server', body: 'It may have been removed.' },
		offline: !online,
		errorTitle: "Couldn't load this server.",
		onretry,
		skeleton
	}}
>
	{#if server}
		<div class="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col">
			{#snippet lead()}
				<div class="flex flex-col gap-3 px-4 pt-4 pb-3">
					{#if justConnected}
						<p
							role="status"
							class="flex items-center gap-2 rounded-xl bg-review-soft px-3 py-2.5 text-sm text-review"
						>
							<Plug class="size-4 shrink-0" aria-hidden="true" />Connected. The agent can use these
							tools from its next turn.
						</p>
					{/if}
					<header class="flex flex-col gap-2">
						<span class="flex flex-wrap items-center gap-2">
							{#if server.status === 'connected'}<StatePill of="active" label="Connected" />
							{:else if server.status === 'signed-out'}<StatePill
									of="waiting"
									label="Sign in again"
								/>
							{:else}<StatePill of="failed" label="Not working" />{/if}
						</span>
						<code class="font-mono text-meta [overflow-wrap:anywhere] text-muted-foreground"
							>{server.url}</code
						>
						{#if server.problem}<p class="text-sm">{server.problem}</p>{/if}
						<div class="flex flex-wrap gap-2">
							<Button variant="outline" disabled={busy || !online} onclick={onreconnect}
								>Reconnect</Button
							>
							{#if server.enabled !== false}<Button
									variant="outline"
									disabled={busy || !online}
									onclick={ondisconnect}>Disconnect</Button
								>{/if}
							{#if signInHref}<Button variant="outline" href={signInHref}
									>Sign in / replace token</Button
								>{/if}
							<Button
								variant="ghost"
								disabled={busy || !online}
								onclick={() => (removing = !removing)}>Remove…</Button
							>
						</div>
						{#if removing}
							<p class="text-sm">
								Remove this connection and its saved credentials? Your account data stays with the
								provider.
							</p>
							<div class="flex gap-2">
								<Button variant="outline" disabled={busy || !online} onclick={onremove}
									>Remove connection</Button
								><Button variant="ghost" onclick={() => (removing = false)}>Cancel</Button>
							</div>
						{/if}
						{#if error}<p role="alert" class="text-sm text-failed">{error}</p>{/if}
					</header>
				</div>
			{/snippet}
			<SwipeableTabs
				tabs={[
					{ value: 'tools', label: 'Tools' },
					{ value: 'history', label: 'History' },
					{ value: 'used', label: 'Used by' }
				]}
				bind:value={section}
				label="Connection sections"
				{lead}
			>
				{#snippet children(tabValue)}
					{#if tabValue === 'tools'}
						<div class="px-4 pt-4 pb-12">
							<section aria-labelledby="{uid}-tools" class="flex flex-col gap-2">
								<h2
									id="{uid}-tools"
									class="flex flex-wrap items-baseline justify-between gap-2 text-sm font-semibold"
								>
									Tools
									<span class="text-meta font-normal text-muted-foreground"
										>list saved {ago(server.snapshotAt, now)}</span
									>
								</h2>
								{#if server.changed}
									<p class="text-sm text-muted-foreground">
										Marked lines show changes since the saved snapshot. Added and changed tools are
										available without approval.
									</p>
								{/if}
								<ul class="flex flex-col divide-y rounded-xl border text-sm">
									{#each server.toolList as t (t.name)}
										<li
											class={cn(
												'grid grid-cols-[1.5rem_1fr] py-2 pr-3',
												t.change === 'added' && 'bg-add',
												t.change === 'removed' && 'bg-del'
											)}
										>
											<span class="text-center text-muted-foreground" aria-hidden="true"
												>{t.change ? mark[t.change] : ''}</span
											>
											<span class="flex min-w-0 flex-col gap-0.5">
												<span class="flex flex-wrap items-center gap-2">
													<code
														class={cn(
															'font-mono text-code',
															t.change === 'removed' && 'line-through'
														)}>{t.name}</code
													>
													{#if t.change}
														<span class="text-meta font-medium"
															>{t.change === 'added'
																? 'New on the server'
																: t.change === 'changed'
																	? 'Definition changed'
																	: 'Gone from the server'}</span
														>
													{/if}
												</span>
												<span class="[overflow-wrap:anywhere] text-muted-foreground"
													>{t.description}</span
												>
											</span>
										</li>
									{/each}
								</ul>
							</section>
						</div>
					{:else if tabValue === 'history'}
						<div class="px-4 pt-4 pb-12">
							<section aria-labelledby="{uid}-hist" class="flex flex-col gap-2">
								<h2 id="{uid}-hist" class="text-sm font-semibold">Connection history</h2>
								<p class="text-sm text-muted-foreground">
									Connection events and saved tool snapshots.
								</p>
								{#if !server.history.length}<p class="text-sm text-muted-foreground">
										No connection events recorded yet.
									</p>{/if}
								<ol class="flex flex-col gap-2.5 border-l pl-4 text-sm">
									{#each server.history as h (h.at + h.event)}
										<li>
											<span class="text-meta text-muted-foreground">{ago(h.at, now)}</span>
											<p class="[overflow-wrap:anywhere]">{h.event}</p>
										</li>
									{/each}
								</ol>
							</section>
						</div>
					{:else if tabValue === 'used'}
						<div class="px-4 pt-4 pb-12">
							<section aria-labelledby="{uid}-used" class="flex flex-col gap-2">
								<h2 id="{uid}-used" class="text-sm font-semibold">Runs using this connection</h2>
								<p class="text-sm text-muted-foreground">
									Open a run to see how the agent used these tools.
								</p>
								{#if server.usedBy.length}
									<ul class="flex flex-col divide-y rounded-xl border text-sm">
										{#each server.usedBy as u (u.runId + u.tool)}
											<li>
												<a
													href={runHref(u.runId)}
													class="flex min-h-12 flex-col justify-center px-3 py-2 hover:bg-muted/60"
												>
													<span class="flex items-center gap-1 font-medium [overflow-wrap:anywhere]"
														>{u.title}<ArrowUpRight
															class="size-3.5 shrink-0"
															aria-hidden="true"
														/></span
													>
													<span class="text-meta text-muted-foreground"
														><code class="font-mono">{u.tool}</code> · {ago(u.at, now)}</span
													>
												</a>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="text-sm text-muted-foreground">No runs have used it yet.</p>
								{/if}
							</section>
						</div>
					{/if}
				{/snippet}
			</SwipeableTabs>
		</div>
	{/if}
</DetailScreen>
