<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Activity from '@lucide/svelte/icons/activity';
	import { Input } from '$lib/ui/input';
	import AppShell from './app-shell.svelte';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { DaySummary } from './types';

	let { days, query = '' }: { days: DaySummary[]; query?: string } = $props();
	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	let q = $state(query);
	const needle = $derived(q.trim().toLowerCase());
	const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
	const shown = $derived(
		days
			.map((d) => ({
				...d,
				sessions: d.sessions.filter((s) => hit(s.title)),
				runs: d.runs.filter((r) => hit(r.title))
			}))
			.filter((d) => !needle || d.sessions.length || d.runs.length || hit(d.summary))
	);
	const matches = $derived(shown.reduce((n, d) => n + d.sessions.length + d.runs.length, 0));
</script>

<AppShell active="history" title="History" waiting={2}>
	<div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-4 @3xl:py-8">
		<form role="search" onsubmit={(e) => e.preventDefault()} class="relative">
			<label for="{uid}-hist-q" class="sr-only">Search history</label>
			<Search
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				id="{uid}-hist-q"
				type="search"
				bind:value={q}
				placeholder="Search sessions, runs and files"
				class="h-10 pl-9"
			/>
		</form>
		{#if needle}
			<p class="-mt-2 text-sm text-muted-foreground">
				{matches}
				{matches === 1 ? 'match' : 'matches'} for “{q.trim()}”
			</p>
		{/if}

		{#each shown as day (day.date)}
			<section
				aria-labelledby="{uid}-d-{day.date.replace(/\W+/g, '-')}"
				class="flex flex-col gap-3"
			>
				<header class="flex flex-col gap-1">
					<h2 id="{uid}-d-{day.date.replace(/\W+/g, '-')}" class="text-sm font-semibold">
						{day.date}
					</h2>
					<p class="text-sm text-muted-foreground">{day.summary}</p>
				</header>
				<div class="grid gap-3 @xl:grid-cols-2">
					{#if day.sessions.length}
						<div class="flex flex-col gap-1.5">
							<h3 class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
								<MessagesSquare class="size-3.5" aria-hidden="true" />Sessions
							</h3>
							<ul class="flex flex-col divide-y rounded-lg border bg-card text-sm">
								{#each day.sessions as s (s.id)}
									<li>
										<a
											href="/chat/{s.id}"
											class="flex items-baseline gap-2 px-3 py-2 hover:bg-muted/60"
										>
											<span class="w-11 shrink-0 text-xs text-muted-foreground tabular-nums"
												>{s.time}</span
											>
											<span class="flex-1">{s.title}</span>
											<span class="text-xs text-muted-foreground tabular-nums"
												>{s.messages} msgs</span
											>
										</a>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if day.runs.length}
						<div class="flex flex-col gap-1.5">
							<h3 class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
								<Activity class="size-3.5" aria-hidden="true" />Runs
							</h3>
							<ul class="flex flex-col divide-y rounded-lg border bg-card text-sm">
								{#each day.runs as r (r.id)}
									<li>
										<a
											href="/history/{r.id}"
											class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 hover:bg-muted/60"
										>
											<span class="w-11 shrink-0 text-xs text-muted-foreground tabular-nums"
												>{r.time}</span
											>
											<span class="min-w-0 flex-1">{r.title}</span>
											<StatePill of={r.state === 'failed' ? 'failed' : r.outcome} />
										</a>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</div>
			</section>
		{:else}
			<p class="text-sm text-muted-foreground">Nothing matches. Try a person, repo or file name.</p>
		{/each}
	</div>
</AppShell>
