<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { ApprovalTray, AskCard } from '$lib/features/chat';
	import { Button } from '$lib/ui/button';
	import { cn } from '$lib/utils';
	import { peekTitle } from '../format';
	import type { HomeItem, HomePeek } from '../types';
	import RecordPeek from './record-peek.svelte';

	let {
		peek,
		now,
		runHref,
		chatHref,
		onclose,
		ondecide,
		onanswer,
		ondismiss,
		onopenrun,
		onopenchat,
		onaskagent
	}: {
		peek: HomePeek;
		now: number;
		runHref: (runId: string) => string;
		chatHref: string;
		onclose?: () => void;
		ondecide?: (nonce: string, decision: 'approve' | 'deny') => void;
		onanswer?: (askId: string, answer: string, index?: number) => void;
		ondismiss?: (id: string) => void;
		onopenrun?: (runId: string) => void;
		onopenchat?: () => void;
		onaskagent?: (item: HomeItem) => void;
	} = $props();

	const title = $derived(peekTitle(peek));
	const uid = $props.id();
</script>

<section aria-labelledby="{uid}-t" class="flex flex-col gap-4 px-4 pt-2 pb-5">
	<h2 id="{uid}-t" class="px-1 text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
		{title}
	</h2>

	{#if peek.item?.kind === 'approval'}
		<div class="@container -mx-2">
			<ApprovalTray
				items={[peek.item.approval]}
				state={peek.submitting ? 'submitting' : 'ready'}
				onapprove={(nonce) => ondecide?.(nonce, 'approve')}
				ondeny={(nonce) => ondecide?.(nonce, 'deny')}
			/>
		</div>
	{:else if peek.item?.kind === 'ask'}
		{@const ask = peek.item.ask}
		<div class="px-1">
			<AskCard {ask} onanswer={(answer, index) => onanswer?.(ask.askId, answer, index)} />
		</div>
	{:else if peek.item}
		<div class="px-1">
			<RecordPeek
				item={peek.item}
				{now}
				{runHref}
				{chatHref}
				{onopenrun}
				{onopenchat}
				{ondismiss}
				{onaskagent}
			/>
		</div>
	{:else if !peek.result}
		<p role="status" class="px-1 text-sm">
			{#if peek.missing === 'offline'}
				You're offline, so this can't be checked right now. It stays on Home until it's handled.
			{:else}
				This isn't waiting any more. It was handled here or on another device.
			{/if}
		</p>
	{/if}

	{#if peek.result}
		<p
			role={peek.result.ok ? 'status' : 'alert'}
			class={cn(
				'flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
				peek.result.ok ? 'bg-muted' : 'bg-failed-soft text-failed'
			)}
		>
			{#if peek.result.ok}
				<CircleCheck class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{:else}
				<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{/if}
			{peek.result.text}
		</p>
	{/if}

	{#if !peek.item || peek.result?.ok}
		<Button variant="outline" onclick={() => onclose?.()} data-autofocus>Close</Button>
	{/if}
</section>
