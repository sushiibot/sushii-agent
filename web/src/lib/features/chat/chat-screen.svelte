<script lang="ts">
	import { tick } from 'svelte';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Download from '@lucide/svelte/icons/download';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FoldVertical from '@lucide/svelte/icons/fold-vertical';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import ServerOff from '@lucide/svelte/icons/server-off';
	import Settings from '@lucide/svelte/icons/settings';
	import Square from '@lucide/svelte/icons/square';
	import Screen from '$lib/ui/screen/screen.svelte';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';
	import InstallHint from '$lib/ui/pwa/install-hint.svelte';
	import UpdateToast from '$lib/ui/pwa/update-toast.svelte';
	import { Button } from '$lib/ui/button';
	import ApprovalTray from './components/approval-tray.svelte';
	import Composer from './components/composer.svelte';
	import Conversation from './components/conversation.svelte';
	import { messagePlainText } from './render/plain-text';
	import { formatCost, formatTokens, shortModel, usageLine } from './render/usage';
	import type { ChatUsage } from '$lib/core/realtime/events';
	import type { ChatMessage, ChatSheet, ChatTray, FileRef, PhotoDraft } from './types';

	let {
		messages,
		history = 'ready',
		hasOlder = false,
		olderLoading = false,
		olderError = false,
		running = false,
		stopping = false,
		tray,
		draft = '',
		photos = [],
		quotaFull = false,
		usage = null,
		connection,
		commandsOffline = false,
		toast,
		updateReady = false,
		canInstall = false,
		announce = '',
		focusAsk,
		sheet,
		viewer,
		newMessages: initialNewMessages = false,
		openTurn,
		openStep,
		settingsHref = '/settings',
		onopensheet,
		onclosesheet,
		onopenfile,
		ondraft,
		onsend,
		onstop,
		oncommand,
		onattach,
		onremovephoto,
		onretryphoto,
		onloadolder,
		onretryhistory,
		onretrysend,
		ondeletesend,
		onanswer,
		ondecide,
		oninstall,
		onreload
	}: {
		messages: ChatMessage[];
		history?: 'loading' | 'ready' | 'error';
		hasOlder?: boolean;
		olderLoading?: boolean;
		olderError?: boolean;
		running?: boolean;
		stopping?: boolean;
		/** Pending approvals, or a timed-out one that is about to fold into its chat marker. */
		tray?: ChatTray;
		draft?: string;
		photos?: PhotoDraft[];
		quotaFull?: boolean;
		/** The newest reply's usage, shown under the composer. */
		usage?: ChatUsage | null;
		connection?: ConnectionState | 'forbidden';
		commandsOffline?: boolean;
		toast?: string | null;
		updateReady?: boolean;
		canInstall?: boolean;
		/** Screen-reader text, set once per completed reply. */
		announce?: string;
		focusAsk?: string;
		sheet?: ChatSheet;
		viewer?: FileRef;
		/** Start with the pill shown, as if the reader had scrolled up while something arrived. */
		newMessages?: boolean;
		openTurn?: string;
		openStep?: string;
		settingsHref?: string;
		onopensheet?: (sheet: ChatSheet, messageId?: string) => void;
		/** Closes the open sheet; called once per close. */
		onclosesheet?: () => void;
		onopenfile?: (file: FileRef) => void;
		ondraft?: (text: string) => void;
		onsend?: () => void;
		onstop?: () => void | Promise<void>;
		oncommand?: (command: 'new' | 'compact') => void | Promise<void>;
		onattach?: (files: File[]) => void;
		onremovephoto?: (id: string) => void;
		onretryphoto?: (id: string) => void;
		onloadolder?: () => Promise<void>;
		onretryhistory?: () => void;
		onretrysend?: (messageId: string) => void;
		ondeletesend?: (messageId: string) => void;
		onanswer?: (askId: string, answer: string) => void;
		ondecide?: (nonce: string, decision: 'approve' | 'deny') => void;
		oninstall?: () => Promise<'accepted' | 'dismissed' | 'failed'>;
		onreload?: () => void;
	} = $props();

	const ARM_MS = 1000;
	const NEAR_BOTTOM_PX = 48;

	let scroller = $state<HTMLElement | null>(null);
	// svelte-ignore state_referenced_locally
	let newMessages = $state(initialNewMessages);
	let armedFor = $state<string | null>(null);
	let armGen = $state(0);
	let slowLoad = $state(false);
	let older = $state<HTMLElement | null>(null);

	// A closing sheet keeps its content until it has slid away.
	// svelte-ignore state_referenced_locally
	let shownSheet = $state<ChatSheet | undefined>(sheet);
	$effect.pre(() => {
		if (sheet) shownSheet = sheet;
	});
	const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
	let copyNote = $state('');
	let copied = $state<string | undefined>();
	const empty = $derived(history !== 'loading' && messages.length === 0);

	// Approve stays locked for a moment whenever a new request reaches the top of the tray or the
	// tray moves. Derived, so a new top request is locked in the same frame it first paints.
	const topNonce = $derived(tray && tray.state !== 'timeout' ? tray.items[0]?.nonce : undefined);
	const armKey = $derived(topNonce ? `${topNonce}:${armGen}` : null);
	const armed = $derived(armKey !== null && armedFor === armKey);
	$effect(() => {
		const key = armKey;
		if (!key) return;
		const t = setTimeout(() => (armedFor = key), ARM_MS);
		return () => clearTimeout(t);
	});
	$effect(() => {
		if (!topNonce) return;
		// The tray's own size changes when it arms, so re-arm on viewport changes (keyboard, rotation)
		// and on returning to the app, not on tray resizes.
		const rearm = () => armGen++;
		const onVisibility = () => {
			if (document.visibilityState === 'visible') rearm();
		};
		const vv = window.visualViewport;
		vv?.addEventListener('resize', rearm);
		window.addEventListener('resize', rearm);
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			vv?.removeEventListener('resize', rearm);
			window.removeEventListener('resize', rearm);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

	const shownTray = $derived(tray && { ...tray, armed: tray.armed ?? armed });

	$effect(() => {
		if (history !== 'loading') {
			slowLoad = false;
			return;
		}
		const t = setTimeout(() => (slowLoad = true), 300);
		return () => clearTimeout(t);
	});

	// The list is column-reverse, so scrollTop is 0 at the newest message and negative above it.
	const fromBottom = (el: HTMLElement) => Math.abs(el.scrollTop);

	let lastTail = '';
	$effect(() => {
		const tail = messages.at(-1);
		const sig = tail ? `${tail.id}:${JSON.stringify(tail.parts).length}` : '';
		if (sig === lastTail) return;
		const first = !lastTail;
		lastTail = sig;
		if (!first && scroller && fromBottom(scroller) > NEAR_BOTTOM_PX) newMessages = true;
	});

	function onScroll() {
		if (scroller && fromBottom(scroller) <= NEAR_BOTTOM_PX) newMessages = false;
	}

	function toBottom() {
		newMessages = false;
		scroller?.scrollTo({ top: 0, behavior: 'instant' });
	}

	$effect(() => {
		const el = scroller;
		if (!el) return;
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	const OLDER_MARGIN_PX = 200;
	let filling = false;

	function olderInView() {
		if (!older || !scroller) return false;
		const root = scroller.getBoundingClientRect();
		const r = older.getBoundingClientRect();
		return r.bottom >= root.top - OLDER_MARGIN_PX && r.top <= root.bottom;
	}

	// The observer fires only when visibility changes, so keep loading while a short page leaves the
	// sentinel on screen.
	async function fillOlder() {
		if (filling) return;
		filling = true;
		try {
			// Bounded, in case a server hands back a cursor that never moves.
			for (let n = 0; n < 20; n++) {
				if (!onloadolder || !hasOlder || olderError || olderLoading || !olderInView()) break;
				await onloadolder();
				await tick();
			}
		} finally {
			filling = false;
		}
	}

	$effect(() => {
		const el = older;
		if (!el || !scroller) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) void fillOlder();
			},
			{ root: scroller, rootMargin: `${OLDER_MARGIN_PX}px 0px 0px 0px` }
		);
		io.observe(el);
		return () => io.disconnect();
	});

	async function copyMessage(message: ChatMessage) {
		const text = messagePlainText(message, location.origin);
		copyNote = '';
		try {
			if (!navigator.clipboard) throw new Error('no clipboard');
			await navigator.clipboard.writeText(text);
			copyNote = 'Copied';
			copied = message.id;
		} catch {
			copyNote = "Couldn't copy";
		}
	}

	function shareMessage(message: ChatMessage) {
		navigator.share({ text: messagePlainText(message, location.origin) }).catch(() => {});
	}

	$effect(() => {
		if (!copyNote) return;
		const t = setTimeout(() => {
			copyNote = '';
			copied = undefined;
		}, 3000);
		return () => clearTimeout(t);
	});
	function closeSheet() {
		if (sheet) onclosesheet?.();
	}

	function send() {
		onsend?.();
		toBottom();
	}

	async function runCommand(c: 'new' | 'compact' | 'stop') {
		closeSheet();
		if (c === 'stop') await onstop?.();
		else await oncommand?.(c);
	}

	const commands = $derived([
		{
			id: 'new' as const,
			icon: MessageSquarePlus,
			label: 'New chat',
			note: commandsOffline
				? "Can't start a new chat while the agent is offline."
				: 'Archive this conversation and start fresh. The agent keeps its memory.',
			disabled: commandsOffline
		},
		{
			id: 'stop' as const,
			icon: Square,
			label: 'Stop',
			note: running ? 'Stop the turn that is running now.' : 'Nothing is running right now.',
			disabled: commandsOffline || !running
		},
		{
			id: 'compact' as const,
			icon: FoldVertical,
			label: 'Compact',
			note: 'Summarize older messages so the agent has room to work.',
			disabled: commandsOffline
		}
	]);
	function usageLabel(u: ChatUsage): string {
		const parts = [`model ${shortModel(u.model)}`];
		if (u.contextPct !== undefined) parts.push(`context ${Math.round(u.contextPct)}%`);
		if (u.costUsd !== undefined) parts.push(`cost ${formatCost(u.costUsd)}`);
		return `Last reply: ${parts.join(', ')}`;
	}

	function usageRows(u: ChatUsage): [string, string][] {
		const rows: [string, string][] = [['Model', u.model]];
		if (u.contextPct !== undefined) rows.push(['Context used', `${Math.round(u.contextPct)}%`]);
		rows.push(
			['Tokens in', formatTokens(u.inputTokens)],
			['Tokens out', formatTokens(u.outputTokens)]
		);
		if (u.cacheRead !== undefined) rows.push(['Cache read', formatTokens(u.cacheRead)]);
		if (u.cacheWrite !== undefined) rows.push(['Cache write', formatTokens(u.cacheWrite)]);
		if (u.costUsd !== undefined) rows.push(['Cost', formatCost(u.costUsd)]);
		return rows;
	}

	const install = () => oninstall?.() ?? Promise.resolve('failed' as const);

	const sheetLabels: Record<ChatSheet, string> = {
		commands: 'Chat commands',
		new: 'Start a new chat',
		viewer: 'Image',
		usage: 'Last reply usage'
	};
</script>

{#snippet sheetBody()}
	{#if shownSheet === 'commands'}
		<div class="flex flex-col gap-2 px-3 pt-1 pb-3">
			<h2 class="px-2 pt-1 text-lg font-semibold">Chat commands</h2>
			{#if commandsOffline}
				<p
					role="status"
					class="mx-2 flex items-start gap-2 rounded-lg bg-waiting-soft px-3 py-2 text-sm text-waiting"
				>
					<ServerOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					Can't run commands while the agent is offline.
				</p>
			{/if}
			<ul class="flex flex-col">
				{#each commands as c (c.id)}
					<li>
						<button
							type="button"
							disabled={c.disabled}
							onclick={() => (c.id === 'new' ? onopensheet?.('new') : runCommand(c.id))}
							class="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-55"
						>
							<c.icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="flex flex-col gap-0.5">
								<span class="text-body font-medium">{c.label}</span>
								<span class="text-sm text-muted-foreground">{c.note}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{:else if shownSheet === 'new'}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">Start a new chat?</h2>
				<p class="text-sm text-muted-foreground">
					The agent keeps its memory; this conversation is archived. Starting can take up to 4
					minutes.
				</p>
			</div>
			<div class="flex flex-col gap-2">
				<Button size="lg" disabled={commandsOffline} onclick={() => runCommand('new')}
					><MessageSquarePlus />Start new chat</Button
				>
				<Button size="lg" variant="ghost" onclick={closeSheet}>Cancel</Button>
			</div>
		</div>
	{:else if shownSheet === 'viewer' && viewer?.src}
		<div class="flex flex-col gap-3 px-4 pt-1 pb-4">
			<img src={viewer.src} alt={viewer.name} class="w-full rounded-xl border object-contain" />
			<p class="text-sm [overflow-wrap:anywhere]">
				{viewer.name}{#if viewer.size}<span class="text-muted-foreground">
						· {viewer.size}</span
					>{/if}
			</p>
			<div class="flex gap-2">
				<Button variant="outline" class="flex-1" href={viewer.src} download={viewer.name}
					><Download />Download</Button
				>
				<Button variant="ghost" class="flex-1" onclick={closeSheet}>Close</Button>
			</div>
		</div>
	{:else if shownSheet === 'usage' && usage}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">Last reply</h2>
				<p class="text-sm text-muted-foreground">What the last reply used, not a running total.</p>
			</div>
			<dl class="flex flex-col divide-y rounded-xl border bg-card text-sm">
				{#each usageRows(usage) as [label, value] (label)}
					<div class="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5">
						<dt class="text-muted-foreground">{label}</dt>
						<dd class="text-right [overflow-wrap:anywhere] tabular-nums">{value}</dd>
					</div>
				{/each}
			</dl>
			<Button size="lg" variant="ghost" onclick={closeSheet}>Close</Button>
		</div>
	{/if}
{/snippet}

{#snippet subtitle()}
	<span class="text-xs text-muted-foreground">
		{#if running}The agent is working{:else}Your agent{/if}
	</span>
{/snippet}

{#snippet actions()}
	<Button
		variant="ghost"
		class="size-12 px-0"
		aria-label="Chat commands"
		onclick={() => onopensheet?.('commands')}><EllipsisVertical class="size-5" /></Button
	>
	<a
		href={settingsHref}
		aria-label="Settings"
		class="grid size-12 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
	>
		<Settings class="size-5" aria-hidden="true" />
	</a>
{/snippet}

{#snippet banner()}
	{#if connection}<ConnectionBanner state={connection} />{/if}
{/snippet}

{#snippet toastBody()}
	{#if toast}{toast}{:else}<UpdateToast onreload={() => onreload?.()} />{/if}
{/snippet}

{#snippet usageStatus()}
	<!-- Its height is held from the first frame, so the composer never moves when usage arrives. -->
	<div class="-mt-2 -mb-2.5 flex h-12 min-w-0">
		{#if usage}
			<!-- Muted and plain: it opens a details sheet and nothing else. -->
			<button
				type="button"
				aria-haspopup="dialog"
				aria-label={usageLabel(usage)}
				onclick={() => onopensheet?.('usage')}
				class="flex w-full min-w-0 items-center justify-center text-meta text-muted-foreground hover:text-foreground"
			>
				<span class="truncate">{usageLine(usage)}</span>
			</button>
		{/if}
	</div>
{/snippet}

{#snippet footer()}
	{#if newMessages}
		<div class="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-3">
			<Button
				variant="outline"
				class="pointer-events-auto rounded-full bg-background px-4 shadow-md dark:bg-card"
				onclick={toBottom}><ArrowDown />New messages</Button
			>
		</div>
	{/if}
	<div class="border-t">
		{#if shownTray}
			<ApprovalTray
				{...shownTray}
				onapprove={(nonce) => ondecide?.(nonce, 'approve')}
				ondeny={(nonce) => ondecide?.(nonce, 'deny')}
			/>
		{/if}
		<Composer
			bind:value={() => draft, (v) => ondraft?.(v)}
			{running}
			{stopping}
			stop={!shownTray || !!shownTray.collapsed}
			{photos}
			{quotaFull}
			onsend={send}
			onstop={() => void onstop?.()}
			onattach={(files) => onattach?.(files)}
			onremovephoto={(id) => onremovephoto?.(id)}
			onretryphoto={(id) => onretryphoto?.(id)}
			status={usageStatus}
		/>
	</div>
{/snippet}

<Screen
	title="Main"
	{subtitle}
	{actions}
	{banner}
	{footer}
	toast={toast || updateReady ? toastBody : undefined}
	stickToBottom={!empty}
	bind:scroller
>
	{#if empty}
		<div class="mx-auto flex h-full max-w-2xl flex-col gap-6 px-4 py-6">
			<InstallHint {canInstall} oninstall={install} />
			<div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
				<span
					class="grid size-14 place-items-center rounded-2xl bg-foreground text-background"
					aria-hidden="true"
				>
					<svg viewBox="0 0 16 16" class="size-7"
						><circle
							cx="8"
							cy="8"
							r="5"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						/><circle cx="8" cy="8" r="1.6" fill="currentColor" /></svg
					>
				</span>
				<p class="flex max-w-72 flex-col gap-1">
					<span class="text-lg font-semibold text-balance">Say hi to your agent.</span>
					<span class="text-sm text-muted-foreground"
						>Replies, questions and approvals show up here.</span
					>
				</p>
			</div>
		</div>
	{:else}
		<div class="mx-auto max-w-2xl">
			<div class="px-4 pt-4">
				<InstallHint {canInstall} oninstall={install} />
			</div>
			{#if hasOlder && !olderError}
				<div bind:this={older} class="flex justify-center px-4 pt-2">
					<Button variant="ghost" disabled={olderLoading} onclick={() => onloadolder?.()}>
						{#if olderLoading}<LoaderCircle
								class="animate-spin motion-reduce:animate-none"
								aria-hidden="true"
							/>Loading earlier messages…{:else}<ChevronUp />Show earlier messages{/if}
					</Button>
				</div>
			{/if}
			{#if history === 'loading' && slowLoad && !messages.length}
				<div class="flex flex-col gap-4 px-4 py-4" aria-hidden="true">
					{#each [60, 85, 45, 70] as w, i (i)}
						<span
							class="h-10 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none {i % 2
								? 'self-end'
								: ''}"
							style="width: {w}%"
						></span>
					{/each}
				</div>
				<p role="status" class="sr-only">Loading messages…</p>
			{/if}
			<Conversation
				{messages}
				{focusAsk}
				{openTurn}
				{openStep}
				onopenfile={(f) => onopenfile?.(f)}
				onretrysend={(id) => onretrysend?.(id)}
				ondeletesend={(id) => ondeletesend?.(id)}
				onanswer={(askId, answer) => onanswer?.(askId, answer)}
				onretryhistory={() => onretryhistory?.()}
				oncopy={copyMessage}
				onshare={canShare ? shareMessage : undefined}
				{copied}
			/>
		</div>
	{/if}
	<p role="status" class="sr-only">{announce}</p>
	<p role="status" class="sr-only">{copyNote}</p>
</Screen>

<RoutedSheet open={!!sheet} label={shownSheet ? sheetLabels[shownSheet] : ''} onclose={closeSheet}
	>{@render sheetBody()}</RoutedSheet
>
