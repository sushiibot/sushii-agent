<script lang="ts">
	// Alerts and runs are the agent's own records: neutral styling, plain text, never the approval look.
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import Check from '@lucide/svelte/icons/check';
	import Reply from '@lucide/svelte/icons/reply';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import X from '@lucide/svelte/icons/x';
	import { Markdown } from '$lib/features/chat';
	import { kindLabel } from '$lib/features/runs';
	import { Button } from '$lib/ui/button';
	import { ago, duration } from '$lib/ui/format/time';
	import StatePill from '$lib/ui/status/state-pill.svelte';
	import type { HomeItem } from '../types';

	let {
		item,
		now,
		onopenrun,
		onopenchat,
		ondismiss,
		ondone,
		onreply,
		onaskagent
	}: {
		item: Exclude<HomeItem, { kind: 'approval' | 'ask' }>;
		now: number;
		onopenrun?: (runId: string) => void;
		onopenchat?: () => void;
		ondismiss?: (id: string) => void;
		ondone?: (id: string) => void;
		onreply?: (item: HomeItem) => void;
		onaskagent?: (item: HomeItem) => void;
	} = $props();

	const triggers: Record<string, string> = {
		daily: 'Its daily schedule',
		interval: 'Its repeating schedule',
		catchup: 'A catch-up after downtime',
		manual: 'You, by hand'
	};
	const triggerLabel = (t: string) => triggers[t] ?? t;
</script>

{#snippet facts(rows: [string, string][])}
	<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
		{#each rows as [k, v] (k)}
			<dt class="text-muted-foreground">{k}</dt>
			<dd class="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
		{/each}
	</dl>
{/snippet}

<div class="flex flex-col gap-4">
	{#if item.kind === 'alert'}
		{@const a = item.alert}
		<div class="flex flex-wrap items-center gap-2">
			<StatePill
				of={a.kind === 'stuck' ? 'stale' : 'failed'}
				label={a.kind === 'stuck' ? 'Stuck' : 'Failed'}
			/>
			<span class="text-sm text-muted-foreground">Scheduled job</span>
		</div>
		{#if a.error}
			<p
				class="rounded-lg border bg-muted/50 px-3 py-2 font-mono text-code [overflow-wrap:anywhere] whitespace-pre-wrap"
			>
				{a.error}
			</p>
		{/if}
		{@render facts([
			['Schedule', a.schedule],
			['Failing since', ago(a.firstAt, now)],
			['Last try', ago(a.lastAt, now)],
			['Started by', triggerLabel(a.trigger)]
		])}
		{#if a.disabled}
			<p class="text-sm">The scheduler turned this job off. It won't run again until it's fixed.</p>
		{/if}
		<div class="flex flex-col gap-2">
			{#if a.runId && onopenrun}
				<Button onclick={() => onopenrun(a.runId!)}>View activity<ArrowUpRight /></Button>
			{/if}
			<div class="flex gap-2">
				<Button variant="outline" class="flex-1" onclick={() => onaskagent?.(item)}
					><MessageSquare />Ask the agent</Button
				>
				<Button variant="ghost" class="px-4" onclick={() => ondismiss?.(item.id)}
					><X />Dismiss</Button
				>
			</div>
		</div>
	{:else if item.kind === 'message'}
		{@const m = item.message}
		<p class="text-sm text-muted-foreground">Scheduled · {m.job} · {ago(m.at, now)}</p>
		<div class="text-ui [overflow-wrap:anywhere]"><Markdown text={m.text} /></div>
		<div class="flex flex-col gap-2">
			<Button onclick={() => onreply?.(item)}><Reply />Discuss</Button>
			<div class="flex gap-2">
				{#if m.runId && onopenrun}
					<Button variant="outline" class="flex-1" onclick={() => onopenrun(m.runId!)}
						>View activity<ArrowUpRight /></Button
					>
				{/if}
				<Button variant="outline" class="flex-1" onclick={() => ondone?.(item.id)}
					><Check />Done</Button
				>
			</div>
		</div>
	{:else if item.kind === 'run'}
		{@const r = item.run}
		<div class="flex flex-wrap items-center gap-2">
			<StatePill of={r.status} />
			<span class="text-sm text-muted-foreground">{kindLabel(r)}</span>
		</div>
		{#if r.resultSummary}
			<p class="text-sm [overflow-wrap:anywhere]">
				<span class="text-muted-foreground">The agent noted:</span>
				{r.resultSummary}
			</p>
		{/if}
		{@render facts([
			['Started', ago(r.startedAt, now)],
			r.endedAt
				? ['Took', duration(Date.parse(r.endedAt) - Date.parse(r.startedAt))]
				: ['Running for', duration(now - Date.parse(r.startedAt))]
		])}
		<div class="flex gap-2">
			{#if onopenrun}
				<Button class="flex-1" onclick={() => onopenrun(r.runId)}
					>View activity<ArrowUpRight /></Button
				>
			{/if}
			{#if item.group === 'failed'}
				<Button variant="ghost" class="px-4" onclick={() => ondismiss?.(item.id)}
					><X />Dismiss</Button
				>
			{:else if item.group === 'review'}
				<Button variant="outline" class="px-4" onclick={() => ondone?.(item.id)}
					><Check />Done</Button
				>
			{/if}
		</div>
	{:else if item.kind === 'turn'}
		<p class="text-sm">
			{item.turn.step ? `Now: ${item.turn.step}` : 'The agent is working on your last message.'}
		</p>
		{@render facts([
			['Running for', duration(now - item.turn.startedAt)],
			['Steps so far', String(item.turn.toolCount)]
		])}
		<Button onclick={() => onopenchat?.()}><MessageSquare />Open chat</Button>
	{:else}
		<p class="text-sm">
			The agent sent a sign-in link in the chat and is waiting until you use it.
		</p>
		<Button onclick={() => onopenchat?.()}><MessageSquare />Open chat</Button>
	{/if}
</div>
