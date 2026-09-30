<script lang="ts">
	import ThumbsUp from '@lucide/svelte/icons/thumbs-up';
	import ThumbsDown from '@lucide/svelte/icons/thumbs-down';
	import X from '@lucide/svelte/icons/x';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import { Button } from '$lib/ui/button';
	import { cn } from '$lib/utils';
	import AppShell from '$lib/ui/shell/app-shell.svelte';
	import type { BriefItem } from './types';

	type Vote = 'up' | 'down';
	let {
		items,
		dismissed: initialDismissed = [],
		votes: initialVotes = {}
	}: { items: BriefItem[]; dismissed?: string[]; votes?: Record<string, Vote> } = $props();
	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	let dismissed = $state<string[]>(initialDismissed);
	// svelte-ignore state_referenced_locally
	let votes = $state<Record<string, Vote>>(initialVotes);
	function vote(id: string, v: Vote) {
		if (votes[id] === v) delete votes[id];
		else votes[id] = v;
	}
	const sections = $derived(
		(['Top of mind', 'Looking ahead'] as const).map((name) => ({
			name,
			items: items.filter((i) => i.section === name)
		}))
	);
	const rated = $derived(Object.keys(votes).length);
</script>

<AppShell active="brief" title="Morning briefing" waiting={2}>
	<div class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-4 @3xl:py-8">
		<header class="flex flex-col gap-1">
			<h2 class="text-xl font-semibold tracking-tight">Tuesday, September 29</h2>
			<p class="text-sm text-muted-foreground">
				{items.length - dismissed.length} of {items.length} items open · sent to Discord at 07:30
			</p>
		</header>

		{#each sections as section (section.name)}
			<section
				aria-labelledby="{uid}-s-{section.name.replaceAll(' ', '-')}"
				class="flex flex-col gap-2"
			>
				<h3
					id="{uid}-s-{section.name.replaceAll(' ', '-')}"
					class="text-sm font-semibold text-muted-foreground"
				>
					{section.name}
				</h3>
				<ul class="flex flex-col gap-2">
					{#each section.items as item (item.id)}
						{@const gone = dismissed.includes(item.id)}
						<li class={cn('rounded-lg border bg-card', gone && 'border-dashed bg-transparent')}>
							{#if gone}
								<div
									class="flex items-center justify-between gap-2 px-3 py-2 text-sm text-muted-foreground"
								>
									<span class="truncate">Dismissed: {item.title}</span>
									<Button
										variant="ghost"
										size="sm"
										onclick={() => (dismissed = dismissed.filter((d) => d !== item.id))}
										>Undo</Button
									>
								</div>
							{:else}
								<div class="flex flex-col gap-1 px-3 pt-3">
									<p class="font-medium">{item.title}</p>
									<p class="text-sm text-muted-foreground">{item.detail}</p>
									<a
										href={item.source.href}
										class="mt-1 inline-flex items-center gap-1 self-start text-sm font-medium text-brand hover:underline"
									>
										{item.source.label}<ArrowUpRight class="size-3.5" aria-hidden="true" />
									</a>
								</div>
								<div class="flex items-center gap-1 px-1.5 py-1.5">
									<Button
										variant="ghost"
										size="icon-lg"
										aria-label="Useful"
										aria-pressed={votes[item.id] === 'up'}
										onclick={() => vote(item.id, 'up')}
										class={cn(
											votes[item.id] === 'up' &&
												'bg-review-soft text-review hover:bg-review-soft hover:text-review'
										)}
									>
										<ThumbsUp />
									</Button>
									<Button
										variant="ghost"
										size="icon-lg"
										aria-label="Not useful"
										aria-pressed={votes[item.id] === 'down'}
										onclick={() => vote(item.id, 'down')}
										class={cn(
											votes[item.id] === 'down' &&
												'bg-failed-soft text-failed hover:bg-failed-soft hover:text-failed'
										)}
									>
										<ThumbsDown />
									</Button>
									<Button
										variant="ghost"
										size="lg"
										class="ml-auto text-muted-foreground"
										onclick={() => (dismissed = [...dismissed, item.id])}
									>
										<X />Dismiss
									</Button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}

		<p class="text-sm text-muted-foreground">
			{rated
				? `${rated} rated. Tomorrow's ranking uses your votes.`
				: 'Rate items to tune what tomorrow leads with.'}
		</p>
	</div>
</AppShell>
