<script lang="ts">
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import CalendarX from '@lucide/svelte/icons/calendar-x';
	import Check from '@lucide/svelte/icons/check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import MessageSquareDot from '@lucide/svelte/icons/message-square-dot';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { kindLabel } from '$lib/features/runs';
	import { ago } from '$lib/ui/format/time';
	import { cn } from '$lib/utils';
	import { messagePreview } from '../format';
	import type { HomeItem } from '../types';

	let {
		item,
		now,
		selected = false,
		onopen,
		ondone
	}: {
		item: HomeItem;
		now: number;
		selected?: boolean;
		onopen?: (id: string) => void;
		/** Set for inbox rows: a sideways swipe marks the item done. The peek's Done button does the same. */
		ondone?: (id: string) => void;
	} = $props();

	const read = $derived('read' in item && item.read);
	const SWIPE_START_PX = 12;
	const SWIPE_DONE_RATIO = 0.35;
	let width = $state(0);
	let offset = $state(0);
	let gone = $state(false);
	let dragging = $state(false);
	let drag: { id: number; x: number; y: number; swiping: boolean } | null = null;
	let swiped = false;

	function down(e: PointerEvent) {
		// A swipe released short of done ends in no click on touch screens, so it can't leave this set.
		swiped = false;
		if (!ondone || e.pointerType === 'mouse' || !e.isPrimary) return;
		drag = { id: e.pointerId, x: e.clientX, y: e.clientY, swiping: false };
	}

	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const dx = e.clientX - drag.x;
		const dy = e.clientY - drag.y;
		if (!drag.swiping) {
			if (Math.abs(dy) > SWIPE_START_PX) drag = null;
			else if (Math.abs(dx) > SWIPE_START_PX) {
				drag.swiping = true;
				dragging = true;
				(e.currentTarget as Element).setPointerCapture(e.pointerId);
			}
			return;
		}
		offset = dx;
	}

	function up(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		const swiping = drag.swiping;
		drag = null;
		dragging = false;
		if (!swiping) return;
		swiped = true;
		if (Math.abs(offset) > width * SWIPE_DONE_RATIO) {
			gone = true;
			offset = Math.sign(offset) * width;
			ondone?.(item.id);
		} else offset = 0;
	}

	function cancel() {
		drag = null;
		dragging = false;
		offset = 0;
	}

	function click() {
		// The click that ends a swipe isn't a tap.
		if (swiped) {
			swiped = false;
			return;
		}
		onopen?.(item.id);
	}

	const view = $derived.by(() => {
		switch (item.kind) {
			case 'approval':
				return {
					title: `Approve ${item.approval.view.tool}`,
					sub: `Requested by ${item.approval.view.agentName}`,
					when: ago(item.at, now)
				};
			case 'ask':
				return { title: item.ask.question, sub: 'The agent asks', when: ago(item.at, now) };
			case 'auth':
				return {
					title: 'Sign-in needed',
					sub: 'The agent is waiting for you to sign in',
					when: ago(item.at, now)
				};
			case 'alert':
				return {
					title: `${item.alert.job} ${item.alert.kind === 'stuck' ? 'is stuck' : 'failed'}`,
					sub: item.alert.error ?? `Scheduled · ${item.alert.schedule}`,
					when: ago(item.alert.lastAt, now)
				};
			case 'turn':
				return {
					title: 'Main chat',
					sub: item.turn.step ? `Working: ${item.turn.step}` : 'The agent is working',
					when: ago(item.at, now)
				};
			case 'message':
				return {
					title: messagePreview(item.message.text),
					sub: `Scheduled · ${item.message.job}`,
					when: ago(item.at, now)
				};
			case 'run':
				return {
					title: item.run.title,
					sub:
						item.group === 'failed'
							? `${kindLabel(item.run)} · ${item.run.status === 'timeout' ? 'Timed out' : 'Failed'}`
							: kindLabel(item.run),
					when: ago(item.at, now)
				};
		}
	});
</script>

<div class="relative overflow-hidden rounded-xl" bind:clientWidth={width}>
	{#if ondone && offset !== 0}
		<div
			class={cn(
				'absolute inset-0 flex items-center bg-review-soft px-5 text-review',
				offset < 0 ? 'justify-end' : 'justify-start'
			)}
			aria-hidden="true"
		>
			<Check class="size-5" />
		</div>
	{/if}
	<button
		type="button"
		aria-haspopup="dialog"
		aria-current={selected || undefined}
		onclick={click}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={cancel}
		style:transform={offset ? `translateX(${offset}px)` : undefined}
		class={cn(
			'relative flex min-h-16 w-full items-start gap-3 rounded-xl bg-background px-2 py-2.5 text-left transition-colors hover:bg-muted/60',
			ondone && 'touch-pan-y',
			!dragging && 'motion-safe:transition-transform',
			selected && 'bg-muted/60',
			gone && 'opacity-0'
		)}
	>
		{#if item.kind === 'approval'}
			<span
				class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-approval text-approval-surface"
			>
				<ShieldCheck class="size-4" aria-label="Approval" />
			</span>
		{:else}
			<span
				class={cn(
					'mt-0.5 grid size-8 shrink-0 place-items-center rounded-full',
					item.group === 'waiting' && 'bg-waiting-soft text-waiting',
					item.group === 'failed' && 'bg-failed-soft text-failed',
					item.group === 'running' && 'bg-running-soft text-running',
					item.group === 'review' && 'bg-review-soft text-review'
				)}
			>
				{#if item.kind === 'ask'}
					<MessageCircleQuestion class="size-4" aria-label="Question" />
				{:else if item.kind === 'auth'}
					<KeyRound class="size-4" aria-label="Sign-in" />
				{:else if item.kind === 'alert'}
					<CalendarX class="size-4" aria-label="Scheduled job" />
				{:else if item.kind === 'turn'}
					<MessageSquare class="size-4" aria-label="Chat" />
				{:else if item.group === 'failed'}
					<CircleX class="size-4" aria-label="Failed run" />
				{:else if item.group === 'running'}
					<LoaderCircle
						class="size-4 animate-spin [animation-duration:2s] motion-reduce:animate-none"
						aria-label="Running"
					/>
				{:else if item.kind === 'message'}
					<CalendarClock class="size-4" aria-label="Scheduled job message" />
				{:else}
					<MessageSquareDot class="size-4" aria-label="Finished run" />
				{/if}
			</span>
		{/if}
		<span class="flex min-w-0 flex-1 flex-col gap-0.5">
			<span class="flex items-baseline justify-between gap-3">
				<span
					class={cn(
						'line-clamp-2 text-ui [overflow-wrap:anywhere]',
						read ? 'text-muted-foreground' : 'font-medium'
					)}
					>{#if read}<span class="sr-only">Read: </span>{/if}{view.title}</span
				>
				<span class="shrink-0 text-meta text-muted-foreground tabular-nums">{view.when}</span>
			</span>
			<span class="line-clamp-1 text-sm [overflow-wrap:anywhere] text-muted-foreground"
				>{view.sub}</span
			>
		</span>
		<ChevronRight class="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	</button>
</div>
