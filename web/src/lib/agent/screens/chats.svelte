<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import Search from '@lucide/svelte/icons/search';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import AppShell from '../app-shell.svelte';
	import SessionIcon from '../session-icon.svelte';
	import type { Session, SessionState } from '../types';

	let {
		sessions,
		cap = 8,
		archivedOpen = false,
		query = ''
	}: { sessions: Session[]; cap?: number; archivedOpen?: boolean; query?: string } = $props();
	const uid = $props.id();

	const q = $derived(query.trim().toLowerCase());
	const matches = $derived(
		sessions.filter(
			(s) =>
				s.kind !== 'project' &&
				(s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q))
		)
	);
	const main = $derived(sessions.find((s) => s.kind === 'main'));
	const threads = $derived(sessions.filter((s) => s.kind === 'thread'));
	const active = $derived(threads.filter((s) => s.state !== 'archived'));
	const archived = $derived(threads.filter((s) => s.state === 'archived'));
	const groups = $derived(
		(
			[
				['needs-you', 'Needs you'],
				['running', 'Running'],
				['idle', 'Recent']
			] as [SessionState, string][]
		)
			.map(([state, label]) => ({ state, label, items: active.filter((s) => s.state === state) }))
			.filter((g) => g.items.length)
	);
</script>

{#snippet row(s: Session, big = false)}
	<a
		href="/chats/{s.id}"
		class={cn(
			'flex items-center gap-3 px-3 hover:bg-muted/60',
			big ? 'py-3' : 'py-2.5',
			s.state === 'archived' && 'text-muted-foreground'
		)}
	>
		<SessionIcon kind={s.kind} class={big ? 'size-10' : 'size-9'} />
		<span class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span class="flex items-baseline justify-between gap-3">
				<span class={cn('truncate', big ? 'text-base font-semibold' : 'text-[15px] font-medium')}
					>{s.title}</span
				>
				<span class="shrink-0 text-xs text-muted-foreground">{s.lastActivity}</span>
			</span>
			<span class="flex items-center gap-2">
				<span class="line-clamp-1 flex-1 text-sm text-muted-foreground">{s.preview}</span>
				{#if s.state === 'needs-you'}
					<span
						class="shrink-0 rounded-full bg-waiting-soft px-1.5 text-[11px] leading-5 font-semibold text-waiting"
						>Needs you</span
					>
				{:else if s.state === 'running'}
					<LoaderCircle
						class="size-4 shrink-0 animate-spin text-running motion-reduce:animate-none"
						aria-label="Running"
					/>
				{:else if s.unread}
					<span
						class="min-w-5 shrink-0 rounded-full bg-brand px-1.5 text-center text-[11px] leading-5 font-semibold text-white tabular-nums"
						>{s.unread}<span class="sr-only"> unread</span></span
					>
				{/if}
			</span>
		</span>
	</a>
{/snippet}

{#snippet actions()}
	<Button variant="ghost" size="icon-lg" aria-label="New thread"><Plus class="size-5" /></Button>
{/snippet}

<AppShell active="chats" title="Chats" waiting={2} unread {actions}>
	<div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-4">
		<form role="search" class="relative" onsubmit={(e) => e.preventDefault()}>
			<label for="{uid}-q" class="sr-only">Search chats</label>
			<Search
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				id="{uid}-q"
				type="search"
				value={query}
				placeholder="Search chats and threads"
				class={cn('h-10 pl-9 text-base', q && 'ring-2 ring-ring/40')}
			/>
		</form>

		{#if q}
			<section aria-labelledby="{uid}-results" class="flex flex-col gap-1">
				<h2 id="{uid}-results" class="px-1 pb-1 text-sm font-semibold text-muted-foreground">
					{matches.length} matching
				</h2>
				<ul class="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
					{#each matches as s (s.id)}<li>{@render row(s)}</li>{/each}
				</ul>
			</section>
		{:else}
			{#if main}
				<section aria-label="Main" class="overflow-hidden rounded-xl border bg-card">
					{@render row(main, true)}
				</section>
			{/if}

			{#each groups as g (g.state)}
				<section aria-labelledby="{uid}-{g.state}" class="flex flex-col gap-1">
					<h2 id="{uid}-{g.state}" class="px-1 pb-1 text-sm font-semibold text-muted-foreground">
						{g.label}
					</h2>
					<ul class="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
						{#each g.items as s (s.id)}<li>{@render row(s)}</li>{/each}
					</ul>
				</section>
			{/each}

			<p class="px-1 text-xs text-muted-foreground">
				{active.length} of {cap} active threads. Threads idle for 7 days are archived and stay searchable.
			</p>

			{#if archived.length}
				<details class="group flex flex-col" open={archivedOpen}>
					<summary
						class="flex cursor-pointer list-none items-center gap-2 px-1 pb-1 text-sm font-semibold text-muted-foreground"
					>
						Archived
						<span class="font-normal tabular-nums">{archived.length}</span>
						<ChevronDown
							class="ml-auto size-4 transition-transform group-open:rotate-180"
							aria-hidden="true"
						/>
					</summary>
					<ul class="mt-1 flex flex-col divide-y overflow-hidden rounded-xl border">
						{#each archived as s (s.id)}<li>{@render row(s)}</li>{/each}
					</ul>
				</details>
			{/if}

			<p
				aria-disabled="true"
				class="flex items-center gap-2 rounded-xl border border-dashed px-3 py-2.5 text-sm text-muted-foreground"
			>
				<FolderGit2 class="size-4" aria-hidden="true" />Project sessions for code, coming later
			</p>
		{/if}
	</div>
</AppShell>
