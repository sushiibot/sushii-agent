<script lang="ts">
	import Plug from '@lucide/svelte/icons/plug';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import { Button } from '$lib/ui/button';
	import { cn } from '$lib/utils';
	import AppShell from '$lib/ui/shell/app-shell.svelte';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { McpServer } from './types';

	let { server, justConnected = false }: { server: McpServer; justConnected?: boolean } = $props();
	const uid = $props.id();
</script>

<AppShell
	active="connectors"
	title={server.name}
	back={{ href: '/connectors', label: 'Connectors' }}
	waiting={2}
>
	<div
		class="flex flex-col gap-5 px-4 py-4 @3xl:grid @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:items-start @3xl:gap-8 @3xl:px-6"
	>
		<div class="flex min-w-0 flex-col gap-5">
			{#if justConnected}
				<p
					role="status"
					class="flex items-center gap-2 rounded-md bg-review-soft px-3 py-2 text-sm text-review"
				>
					<Plug class="size-4" aria-hidden="true" />Connected. The agent can use these tools from
					the next turn.
				</p>
			{/if}
			<header class="flex flex-wrap items-center gap-2">
				<StatePill of="active" label="Connected" />
				<code class="min-w-0 truncate font-mono text-xs text-muted-foreground">{server.url}</code>
			</header>

			<section aria-labelledby="{uid}-tools-h" class="flex flex-col gap-2">
				<h2 id="{uid}-tools-h" class="flex items-baseline justify-between text-sm font-semibold">
					Tools snapshot
					<span class="text-xs font-normal text-muted-foreground">saved {server.connectedAt}</span>
				</h2>
				<ul class="flex flex-col divide-y rounded-lg border text-sm">
					{#each server.tools as t (t.name)}
						<li
							class={cn(
								'flex flex-col gap-0.5 px-3 py-2',
								t.change === 'added' && 'bg-add',
								t.change === 'removed' && 'bg-del'
							)}
						>
							<span class="flex items-center gap-2">
								<code class={cn('font-mono text-[13px]', t.change === 'removed' && 'line-through')}
									>{t.name}</code
								>
								{#if t.change}
									<span class="text-xs font-medium"
										>{t.change === 'added' ? 'New since last snapshot' : 'Removed by server'}</span
									>
								{/if}
							</span>
							<span class="text-muted-foreground">{t.description}</span>
						</li>
					{/each}
				</ul>
				<Button size="lg" variant="outline" class="self-start"
					><RefreshCw />Check for changes</Button
				>
			</section>
		</div>

		<div class="flex flex-col gap-5">
			<section aria-labelledby="{uid}-hist-h" class="flex flex-col gap-2">
				<h2 id="{uid}-hist-h" class="text-sm font-semibold">History</h2>
				<ol class="flex flex-col gap-2.5 border-l pl-4 text-sm">
					{#each server.history as h (h.when)}
						<li>
							<span class="text-muted-foreground">{h.when}</span>
							<p>{h.event}</p>
						</li>
					{/each}
				</ol>
			</section>
			<section aria-labelledby="{uid}-used-h" class="flex flex-col gap-2">
				<h2 id="{uid}-used-h" class="text-sm font-semibold">Used by</h2>
				{#if server.usedBy.length}
					<ul class="flex flex-col divide-y rounded-lg border text-sm">
						{#each server.usedBy as u (u.runId)}
							<li>
								<a href="/runs/{u.runId}" class="flex flex-col px-3 py-2 hover:bg-muted/60">
									<span class="flex items-center gap-1 font-medium"
										>{u.title}<ArrowUpRight class="size-3.5" aria-hidden="true" /></span
									>
									<span class="text-xs text-muted-foreground"
										><code class="font-mono">{u.tool}</code> · {u.when}</span
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
	</div>
</AppShell>
