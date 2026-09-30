<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Check from '@lucide/svelte/icons/check';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { cn } from '$lib/utils';
	import AppShell from '../app-shell.svelte';
	import StatePill from '../state-pill.svelte';
	import SetupHint from '../setup-hint.svelte';
	import { status } from '../status';
	import type { InboxItem, RunState } from '../types';

	let {
		items,
		peek: initialPeek,
		draft = '',
		notice,
		hint,
		toast
	}: {
		items: InboxItem[];
		peek?: string;
		draft?: string;
		notice?: string;
		hint?: 'install' | 'push';
		toast?: string;
	} = $props();
	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	let peek = $state(initialPeek);
	// svelte-ignore state_referenced_locally
	let reply = $state(draft);

	const order: RunState[] = ['waiting', 'failed', 'running', 'review'];
	const groups = $derived(
		order
			.map((state) => ({ state, items: items.filter((i) => i.state === state) }))
			.filter((g) => g.items.length)
	);
	const selected = $derived(items.find((i) => i.id === peek));
	const waiting = $derived(items.filter((i) => i.state === 'waiting').length);
</script>

{#snippet peekPanel(item: InboxItem, where: string)}
	<div class="flex flex-col gap-3">
		<div class="flex flex-wrap items-center gap-1.5">
			<StatePill of={item.state} />
			{#if item.tainted}<StatePill of="tainted" />{/if}
			<span class="text-xs text-muted-foreground">{item.source}</span>
		</div>
		<p class="text-sm text-muted-foreground">{item.summary}</p>
		{#if item.question}
			<p class="rounded-md bg-muted px-3 py-2 text-sm font-medium">{item.question}</p>
		{/if}
		{#if item.state === 'waiting'}
			<label class="sr-only" for="{uid}-reply-{where}-{item.id}">Reply</label>
			<Textarea
				id="{uid}-reply-{where}-{item.id}"
				bind:value={reply}
				rows={2}
				placeholder="Reply without opening the chat"
				class={cn('text-base', where === 'sheet' && 'kb:ring-2 kb:ring-ring/40')}
			/>
			<div class="flex flex-wrap gap-2">
				<Button size="lg" disabled={!reply.trim()}><SendHorizontal />Send reply</Button>
				<Button size="lg" variant="outline" href="/runs/{item.runId}"
					>Open run<ArrowUpRight /></Button
				>
			</div>
		{:else if item.state === 'failed'}
			<div class="flex flex-wrap gap-2">
				<Button size="lg" variant="outline" href="/runs/{item.runId}"
					>Open run<ArrowUpRight /></Button
				>
				<Button size="lg" variant="ghost"><RotateCcw />Retry now</Button>
			</div>
		{:else}
			<div class="flex flex-wrap gap-2">
				<Button size="lg" variant="outline" href="/runs/{item.runId}"
					>Open run<ArrowUpRight /></Button
				>
				{#if item.state === 'review'}
					<Button size="lg" variant="ghost"><Check />Mark reviewed</Button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet sheet()}
	{#if selected}
		<div class="flex flex-col gap-3 px-5 pt-2 pb-5">
			<h2 class="text-lg leading-snug font-semibold">{selected.title}</h2>
			{@render peekPanel(selected, 'sheet')}
		</div>
	{/if}
{/snippet}

{#snippet toastBody()}
	<span>{toast}</span>
{/snippet}

<AppShell
	active="home"
	title="Needs you"
	{waiting}
	unread
	sheet={selected ? sheet : undefined}
	sheetLabel={selected?.title}
	toast={toast ? toastBody : undefined}
>
	<div class="@3xl:grid @3xl:h-full @3xl:grid-cols-[minmax(0,1fr)_22rem]">
		<div class="flex flex-col gap-6 px-4 py-4 @3xl:overflow-y-auto @3xl:px-6">
			{#if hint}<SetupHint kind={hint} />{/if}
			{#if notice}
				<p role="status" class="rounded-md bg-running-soft px-3 py-2 text-sm text-running">
					{notice}
				</p>
			{/if}
			{#each groups as group (group.state)}
				{@const meta = status[group.state]}
				<section aria-labelledby="{uid}-g-{group.state}" class="flex flex-col gap-1">
					<h2
						id="{uid}-g-{group.state}"
						class="flex items-center gap-2 px-1 pb-1 text-sm font-semibold text-muted-foreground"
					>
						<meta.icon class="size-4" aria-hidden="true" />
						{meta.label}
						<span class="tabular-nums">{group.items.length}</span>
					</h2>
					<ul class="flex flex-col divide-y rounded-lg border bg-card">
						{#each group.items as item (item.id)}
							{@const open = peek === item.id}
							<li>
								<button
									type="button"
									aria-expanded={open}
									onclick={() => (peek = open ? undefined : item.id)}
									class={cn(
										'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
										open && 'bg-muted/60'
									)}
								>
									<span class="flex items-baseline justify-between gap-3">
										<span class="text-sm font-medium">{item.title}</span>
										<span class="shrink-0 text-xs text-muted-foreground">{item.when}</span>
									</span>
									<span class="text-xs text-muted-foreground">{item.source}</span>
									<span class="line-clamp-1 text-sm text-muted-foreground">{item.summary}</span>
								</button>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
		<aside class="hidden border-l bg-muted/30 p-5 @3xl:block" aria-label="Peek">
			{#if selected}
				<h2 class="mb-3 text-base font-semibold">{selected.title}</h2>
				{@render peekPanel(selected, 'side')}
			{:else}
				<p class="text-sm text-muted-foreground">Select an item to see its question or result.</p>
			{/if}
		</aside>
	</div>
</AppShell>
