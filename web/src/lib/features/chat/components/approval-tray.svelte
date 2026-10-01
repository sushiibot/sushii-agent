<script lang="ts">
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TimerOff from '@lucide/svelte/icons/timer-off';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { untrack } from 'svelte';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { Button } from '$lib/ui/button';
	import { cn } from '$lib/utils';
	import type { PendingApproval } from '../types';

	let {
		items,
		armed = true,
		state: phase = 'ready',
		details: initialDetails = false,
		collapsed = false,
		holdMs = 1000,
		onapprove,
		ondeny
	}: {
		items: PendingApproval[];
		/** The caller's extra hold, e.g. after the tray moves. The tray also holds Approve itself for
		 *  `holdMs` whenever it appears or its top item changes; both must clear. */
		armed?: boolean;
		state?: 'ready' | 'submitting' | 'timeout';
		/** Start with the exact input shown. */
		details?: boolean;
		/** Set a few seconds after a timeout so the tray folds into its chat marker; the caller owns the timer. */
		collapsed?: boolean;
		holdMs?: number;
		onapprove?: (nonce: string) => void;
		ondeny?: (nonce: string) => void;
	} = $props();
	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	let details = $state(initialDetails);
	const top = $derived(items[0] as PendingApproval | undefined);

	// The hold is plain data read directly by the click handler, so a click in the same task as an
	// `items` change is judged against the item it was rendered for, never a stale flag.
	let holdNonce: string | undefined = undefined;
	let holdStart = 0;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	// Bumped when a hold starts or clears, so the button re-renders.
	let holdVersion = $state(0);

	function rearm(nonce: string | undefined) {
		holdNonce = nonce;
		holdStart = performance.now();
		clearTimeout(holdTimer);
		// A frame late, so the re-render never lands a hair before the hold has cleared.
		holdTimer = setTimeout(() => holdVersion++, holdMs + 16);
		holdVersion++;
	}

	function released(nonce: string): boolean {
		if (nonce !== holdNonce) {
			rearm(nonce);
			return false;
		}
		return performance.now() - holdStart >= holdMs;
	}

	// Called during render too, where it must not write state, so a new nonce just reads as held.
	function shownReleased(nonce: string | undefined): boolean {
		return nonce !== undefined && nonce === holdNonce && performance.now() - holdStart >= holdMs;
	}

	$effect(() => {
		const nonce = top?.nonce;
		if (nonce !== holdNonce) untrack(() => rearm(nonce));
	});
	$effect(() => () => clearTimeout(holdTimer));

	const ready = $derived.by(() => {
		void holdVersion;
		return armed && shownReleased(top?.nonce);
	});

	/** Acts only for the item the button was drawn for, and only once its hold has cleared. */
	function decide(e: MouseEvent, approve: boolean) {
		const nonce = (e.currentTarget as HTMLElement).dataset.nonce;
		if (!nonce || nonce !== top?.nonce) return;
		if (!approve) return ondeny?.(nonce);
		if (armed && released(nonce)) onapprove?.(nonce);
	}

	// Buttons that shift under the finger (keyboard, rotation, the tray resizing) are "appearing" again.
	let section = $state<HTMLElement>();
	let row = $state<HTMLElement>();
	$effect(() => {
		if (!section || !row) return;
		const buttons = row;
		let last = buttons.getBoundingClientRect();
		const check = () => {
			const now = buttons.getBoundingClientRect();
			if (Math.abs(now.top - last.top) > 2 || Math.abs(now.left - last.left) > 2) {
				rearm(untrack(() => top?.nonce));
			}
			last = now;
		};
		const observer = new ResizeObserver(check);
		observer.observe(section);
		observer.observe(document.documentElement);
		const viewport = window.visualViewport;
		viewport?.addEventListener('resize', check);
		viewport?.addEventListener('scroll', check);
		window.addEventListener('resize', check);
		return () => {
			observer.disconnect();
			viewport?.removeEventListener('resize', check);
			viewport?.removeEventListener('scroll', check);
			window.removeEventListener('resize', check);
		};
	});

	const view = $derived(top?.view);
	const timedOut = $derived(phase === 'timeout');
	const still = () =>
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
</script>

<svelte:document
	onvisibilitychange={() => {
		// Coming back to the app is "appearing" too: a tap meant for the lock screen must not land here.
		if (document.visibilityState === 'visible') rearm(top?.nonce);
	}}
/>

{#if top && view && !collapsed}
	<section
		bind:this={section}
		aria-labelledby="{uid}-h"
		data-surface="approval"
		out:slide={{ duration: still() ? 0 : 320, easing: cubicOut }}
		class={cn(
			'relative mx-2 mt-2 mb-3 flex min-w-0 flex-col gap-2 rounded-2xl border-2 border-approval/60 bg-approval-surface p-3 text-foreground shadow-[0_-8px_24px_-16px_rgb(0_0_0/0.45)]',
			// The next request peeks out underneath, so a stack reads as a stack.
			items.length > 1 &&
				'mb-4 shadow-[0_6px_0_-2px_var(--approval-surface),0_6px_0_0_color-mix(in_oklch,var(--approval)_45%,transparent)]'
		)}
	>
		<header class="flex items-center gap-2.5">
			<span
				class="grid size-8 shrink-0 place-items-center rounded-full bg-approval text-approval-surface"
			>
				<ShieldCheck class="size-[18px]" aria-hidden="true" />
			</span>
			<h2 id="{uid}-h" class="flex min-w-0 flex-1 flex-col">
				<span class="text-xs leading-tight font-medium text-muted-foreground">
					{timedOut ? 'Approval timed out' : 'sushii-agent needs your approval to run'}
				</span>
				<span class="flex flex-wrap items-baseline gap-x-2">
					<code
						class="min-w-0 font-mono text-sm leading-snug font-semibold [overflow-wrap:anywhere]"
						>{view.tool}</code
					>
					{#if items.length > 1 && !timedOut}<span
							class="text-xs font-medium whitespace-nowrap text-muted-foreground tabular-nums"
							>1 of {items.length}</span
						>{/if}
				</span>
			</h2>
			{#if !timedOut}
				<Button
					variant="ghost"
					class="-my-1.5 -mr-1.5 shrink-0 gap-1 px-3 text-sm font-medium"
					aria-label={details ? 'Hide details' : 'Show details'}
					aria-expanded={details}
					aria-controls="{uid}-input"
					onclick={() => (details = !details)}
				>
					<span class="@max-sm:hidden">{details ? 'Hide details' : 'Show details'}</span>
					<span class="hidden @max-sm:inline">Details</span>
					<ChevronDown
						class={cn(
							'size-4 transition-transform motion-reduce:transition-none',
							details && 'rotate-180'
						)}
						aria-hidden="true"
					/>
				</Button>
			{/if}
		</header>

		{#if timedOut}
			<p role="status" class="flex items-start gap-2 text-sm">
				<TimerOff class="mt-0.5 size-4 shrink-0 text-failed" aria-hidden="true" />
				<span
					><span class="font-semibold">Timed out, denied.</span> Nobody decided within 30 minutes, so
					it did not run.</span
				>
			</p>
		{:else}
			<!-- tabindex: the field list scrolls, so keyboard users need to reach it. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<dl
				id="{uid}-input"
				tabindex="0"
				aria-label="Exact input"
				hidden={!details}
				class="flex max-h-40 flex-col gap-2 overflow-y-auto overscroll-contain rounded-lg border bg-background/70 p-2.5"
			>
				{#each view.fields as field, i (i)}
					<div class="flex flex-col gap-0.5">
						<dt class="text-xs [overflow-wrap:anywhere] text-muted-foreground">{field.key}</dt>
						<dd
							class={cn(
								'font-mono text-code leading-relaxed [overflow-wrap:anywhere]',
								field.kind === 'body' && 'whitespace-pre-wrap'
							)}
						>
							{field.value}
						</dd>
					</div>
				{/each}
				<div class="flex flex-col gap-0.5 border-t pt-2">
					<dt class="text-xs text-muted-foreground">Requested by</dt>
					<dd class="font-mono text-code [overflow-wrap:anywhere]">
						{view.agentName} <span class="font-sans text-muted-foreground">(self-reported)</span>
					</dd>
				</div>
			</dl>
			{#if top.tainted}
				<p class="flex items-start gap-2 rounded-lg bg-taint-soft px-2 py-1 text-xs leading-snug">
					<TriangleAlert class="mt-px size-3.5 shrink-0 text-taint" aria-hidden="true" />
					<span class="min-w-0 [overflow-wrap:anywhere] text-taint">{top.tainted}</span>
				</p>
			{/if}

			{#if phase === 'submitting'}
				<p role="status" class="flex h-12 items-center gap-2 text-sm font-medium">
					<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
					Sending your approval…
				</p>
			{:else}
				<div bind:this={row} class="flex gap-3">
					<Button
						variant="outline"
						class="px-5"
						aria-label="Deny {view.tool}"
						data-nonce={top.nonce}
						onclick={(e) => decide(e, false)}><X />Deny</Button
					>
					<Button
						class="relative min-w-0 flex-1 overflow-hidden"
						disabled={!ready}
						aria-label="Approve {view.tool}"
						aria-describedby={ready ? undefined : `${uid}-hold`}
						data-nonce={top.nonce}
						onclick={(e) => decide(e, true)}
					>
						{#if !ready}
							{#key holdVersion}
								<span
									class="absolute inset-x-0 bottom-0 h-1 origin-left animate-[arm_1s_linear_forwards] bg-primary-foreground/60 motion-reduce:animate-none"
									aria-hidden="true"
								></span>
							{/key}
						{/if}
						<Check />Approve
					</Button>
				</div>
				<!-- Always laid out, so the buttons don't shift when the hold clears. -->
				<p
					id="{uid}-hold"
					aria-hidden={ready}
					class={cn('-mt-1 text-right text-xs text-muted-foreground', ready && 'invisible')}
				>
					Approve unlocks in a moment.
				</p>
			{/if}
		{/if}
	</section>
{/if}

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
