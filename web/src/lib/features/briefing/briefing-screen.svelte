<script lang="ts">
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import ThumbsDown from '@lucide/svelte/icons/thumbs-down';
	import ThumbsUp from '@lucide/svelte/icons/thumbs-up';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/ui/button';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import { clock, longDate } from '$lib/ui/format/time';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import { cn } from '$lib/utils';
	import type { BriefItem, BriefVote, Briefing } from './types';

	let {
		remote,
		briefing,
		now,
		back,
		online = true,
		error = null,
		onvote,
		ondismiss,
		onretry
	}: {
		remote: RemoteLike;
		/** null: no briefing yet today. */
		briefing?: Briefing | null;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		online?: boolean;
		error?: string | null;
		onvote?: (id: string, vote: BriefVote) => void;
		ondismiss?: (id: string, dismissed: boolean) => void;
		onretry?: () => void;
	} = $props();
	const uid = $props.id();

	const sections = $derived(
		(
			[
				['top', 'Top of mind'],
				['ahead', 'Looking ahead']
			] as const
		).map(([id, label]) => ({
			id,
			label,
			items: (briefing?.items ?? []).filter((i) => i.section === id)
		}))
	);
	const open = $derived((briefing?.items ?? []).filter((i) => !i.dismissed).length);
	const rated = $derived((briefing?.items ?? []).filter((i) => i.vote).length);
</script>

{#snippet banner()}
	{#if !online}<ConnectionBanner state={{ kind: 'app-offline' }} />{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-3 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-6 w-1/2" />
		{#each [0, 1, 2] as i (i)}<Skeleton class="h-28 w-full rounded-xl" />{/each}
	</div>
	<p role="status" class="sr-only">Loading the briefing…</p>
{/snippet}

{#snippet item(i: BriefItem)}
	<li class={cn('rounded-xl border bg-card', i.dismissed && 'border-dashed bg-transparent')}>
		{#if i.dismissed}
			<div class="flex items-center gap-2 py-1 pr-1 pl-3 text-sm text-muted-foreground">
				<span class="min-w-0 flex-1 truncate">Dismissed: {i.title}</span>
				<Button variant="ghost" onclick={() => ondismiss?.(i.id, false)}><Undo2 />Undo</Button>
			</div>
		{:else}
			<div class="flex flex-col gap-1 px-3 pt-3">
				<p class="font-medium [overflow-wrap:anywhere]">{i.title}</p>
				<p class="text-sm [overflow-wrap:anywhere] text-muted-foreground">{i.detail}</p>
				{#if i.source.href}
					<a
						href={i.source.href}
						class="-my-1 flex min-h-12 items-center gap-1 self-start text-sm font-medium text-brand hover:underline"
						>{i.source.label}<ArrowUpRight class="size-3.5" aria-hidden="true" /></a
					>
				{:else}
					<p class="py-1 text-meta text-muted-foreground">Source: {i.source.label}</p>
				{/if}
			</div>
			<div class="flex items-center gap-2 px-1.5 pb-1.5">
				<Button
					variant="ghost"
					aria-label="Useful"
					title="Useful"
					aria-pressed={i.vote === 'up'}
					onclick={() => onvote?.(i.id, 'up')}
					class={cn(
						'size-12 px-0',
						i.vote === 'up' && 'bg-review-soft text-review hover:bg-review-soft'
					)}><ThumbsUp /></Button
				>
				<Button
					variant="ghost"
					aria-label="Not useful"
					title="Not useful"
					aria-pressed={i.vote === 'down'}
					onclick={() => onvote?.(i.id, 'down')}
					class={cn('size-12 px-0', i.vote === 'down' && 'bg-muted text-foreground hover:bg-muted')}
					><ThumbsDown /></Button
				>
				<Button
					variant="ghost"
					size="lg"
					class="ml-auto text-muted-foreground"
					onclick={() => ondismiss?.(i.id, true)}><X />Dismiss</Button
				>
			</div>
		{/if}
	</li>
{/snippet}

<DetailScreen
	title="Briefing"
	{back}
	{banner}
	state={{
		remote,
		isEmpty: briefing === null,
		empty: {
			title: 'No briefing yet today',
			body: 'The agent writes one each morning, with where each item came from.'
		},
		offline: !online,
		errorTitle: "Couldn't load the briefing.",
		onretry,
		skeleton
	}}
>
	{#if briefing}
		<div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-4">
			<header class="flex flex-col gap-1">
				<h2 class="text-xl font-semibold tracking-tight">{longDate(briefing.date, now)}</h2>
				<p class="text-sm text-muted-foreground">
					{open} of {briefing.items.length} open · written at {clock(Date.parse(briefing.at))}
				</p>
			</header>
			{#if error}<p role="alert" class="text-sm text-failed">{error}</p>{/if}
			{#each sections as s (s.id)}
				{#if s.items.length}
					<section aria-labelledby="{uid}-{s.id}" class="flex flex-col gap-2">
						<h3 id="{uid}-{s.id}" class="px-1 text-sm font-medium text-muted-foreground">
							{s.label}
						</h3>
						<ul class="flex flex-col gap-2">
							{#each s.items as i (i.id)}{@render item(i)}{/each}
						</ul>
					</section>
				{/if}
			{/each}
			<p role="status" class="px-1 text-sm text-muted-foreground">
				{rated
					? `${rated} rated. Tomorrow's briefing leads with what you found useful.`
					: 'Rate items to tune what tomorrow leads with.'}
			</p>
		</div>
	{/if}
</DetailScreen>
