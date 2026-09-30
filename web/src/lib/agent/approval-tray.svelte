<script lang="ts">
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TimerOff from '@lucide/svelte/icons/timer-off';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';
	import type { PendingApproval } from './types';

	let {
		items,
		armed = true,
		state = 'ready',
		onapprove,
		ondeny,
		onclose
	}: {
		items: PendingApproval[];
		/** False for about 1s after the tray appears or its top item changes; the caller owns the timer. */
		armed?: boolean;
		state?: 'ready' | 'submitting' | 'timeout';
		onapprove?: (nonce: string) => void;
		ondeny?: (nonce: string) => void;
		onclose?: () => void;
	} = $props();
	const uid = $props.id();

	const top = $derived(items[0]);
	const view = $derived(top.view);
	const decided = $derived(state === 'timeout');
</script>

<section
	aria-labelledby="{uid}-h"
	class={cn(
		'relative mx-2 mt-2 flex flex-col rounded-2xl border-2 border-approval/60 bg-approval-surface text-foreground shadow-[0_-8px_24px_-16px_rgb(0_0_0/0.45)]',
		// The next request peeks out underneath, so a stack reads as a stack.
		items.length > 1 &&
			'mb-2 shadow-[0_6px_0_-2px_var(--approval-surface),0_6px_0_0_color-mix(in_oklch,var(--approval)_45%,transparent)]'
	)}
>
	<header class="flex items-start gap-2.5 px-3 pt-3 pb-2">
		<span
			class="grid size-8 shrink-0 place-items-center rounded-full bg-approval text-approval-surface"
		>
			<ShieldCheck class="size-[18px]" aria-hidden="true" />
		</span>
		<h2 id="{uid}-h" class="min-w-0 flex-1 pt-1 text-sm leading-snug font-semibold">
			sushii-agent needs your approval to run <code
				class="font-mono text-[13px] font-semibold [overflow-wrap:anywhere]">{view.tool}</code
			>
		</h2>
		{#if items.length > 1}
			<span class="shrink-0 pt-1 text-xs font-medium text-muted-foreground tabular-nums"
				>1 of {items.length}</span
			>
		{/if}
	</header>

	{#if decided}
		<p class="flex items-start gap-2 px-3 pb-3 text-sm">
			<TimerOff class="mt-0.5 size-4 shrink-0 text-failed" aria-hidden="true" />
			<span
				><span class="font-semibold">Timed out, denied.</span> Nobody decided within 30 minutes, so
				<code class="font-mono text-[13px]">{view.tool}</code> did not run.</span
			>
		</p>
	{:else}
		<!-- tabindex: the field list scrolls, so keyboard users need to reach it. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<dl
			tabindex="0"
			aria-label="Exact input"
			class="mx-3 flex max-h-40 flex-col gap-2 overflow-y-auto overscroll-contain rounded-lg border bg-background/70 p-2.5"
		>
			{#each view.fields as field (field.key)}
				<div class="flex flex-col gap-0.5">
					<dt class="text-xs text-muted-foreground">{field.key}</dt>
					<dd
						class={cn(
							'font-mono text-[13px] leading-relaxed [overflow-wrap:anywhere]',
							field.kind === 'body' && 'whitespace-pre-wrap'
						)}
					>
						{field.value}
					</dd>
				</div>
			{/each}
			<div class="flex flex-col gap-0.5 border-t pt-2">
				<dt class="text-xs text-muted-foreground">Requested by</dt>
				<dd class="font-mono text-[13px] [overflow-wrap:anywhere]">
					{view.agentName} <span class="font-sans text-muted-foreground">(self-reported)</span>
				</dd>
			</div>
		</dl>
		{#if top.tainted}
			<p class="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-taint-soft px-2.5 py-2 text-xs">
				<TriangleAlert class="mt-px size-3.5 shrink-0 text-taint" aria-hidden="true" />
				<span class="text-taint">{top.tainted}</span>
			</p>
		{/if}
	{/if}

	<div class="flex gap-3 p-3">
		{#if decided}
			<Button variant="outline" class="ml-auto" onclick={onclose}>Close</Button>
		{:else if state === 'submitting'}
			<p role="status" class="flex h-12 items-center gap-2 text-sm font-medium">
				<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
				Sending your approval…
			</p>
		{:else}
			<Button variant="outline" class="px-5" onclick={() => ondeny?.(top.nonce)}><X />Deny</Button>
			<Button
				class="relative h-auto min-h-12 min-w-0 flex-1 overflow-hidden py-2 whitespace-normal"
				disabled={!armed}
				aria-describedby={armed ? undefined : `${uid}-hold`}
				onclick={() => onapprove?.(top.nonce)}
			>
				{#if !armed}
					<span
						class="absolute inset-x-0 bottom-0 h-1 origin-left animate-[arm_1s_linear_forwards] bg-primary-foreground/60 motion-reduce:animate-none"
						aria-hidden="true"
					></span>
				{/if}
				<Check /><span class="text-left [overflow-wrap:anywhere]"
					>Approve and run <span class="font-mono text-[13px]">{view.tool}</span></span
				>
			</Button>
		{/if}
	</div>
	{#if !armed && state === 'ready'}
		<p id="{uid}-hold" class="-mt-1.5 px-3 pb-2.5 text-right text-xs text-muted-foreground">
			Approve unlocks in a moment. Read the input first.
		</p>
	{/if}
</section>

<style>
	@keyframes -global-arm {
		from {
			transform: scaleX(0);
		}
		to {
			transform: scaleX(1);
		}
	}
</style>
