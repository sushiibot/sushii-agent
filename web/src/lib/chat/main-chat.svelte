<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Download from '@lucide/svelte/icons/download';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import FoldVertical from '@lucide/svelte/icons/fold-vertical';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import ServerOff from '@lucide/svelte/icons/server-off';
	import Settings from '@lucide/svelte/icons/settings';
	import ShieldOff from '@lucide/svelte/icons/shield-off';
	import Square from '@lucide/svelte/icons/square';
	import AppShell from '$lib/agent/app-shell.svelte';
	import ApprovalTray from '$lib/agent/approval-tray.svelte';
	import Composer from '$lib/agent/composer.svelte';
	import ConnectionBanner from '$lib/agent/connection-banner.svelte';
	import Conversation from '$lib/agent/conversation.svelte';
	import type { ConnectionState, FileRef } from '$lib/agent/types';
	import MessageSheet from '$lib/agent/message-sheet.svelte';
	import { messagePlainText } from '$lib/agent/render/plain-text';
	import InstallHint from '$lib/app/install-hint.svelte';
	import UpdateToast from '$lib/app/update-toast.svelte';
	import { pwa } from '$lib/app/pwa.svelte';
	import { Button } from '$lib/components/ui/button';
	import type { ChatStore } from './store.svelte';

	let { store }: { store: ChatStore } = $props();

	const ARM_MS = 1000;
	const NEAR_BOTTOM_PX = 48;

	let scroller = $state<HTMLElement | null>(null);
	let newMessages = $state(false);
	let armedFor = $state<string | null>(null);
	let armGen = $state(0);
	let viewer = $state<FileRef | undefined>();
	let now = $state(Date.now());
	let slowLoad = $state(false);
	let older = $state<HTMLElement | null>(null);

	const sheet = $derived(page.state.sheet);
	const heldId = $derived(sheet === 'message' ? page.state.messageId : undefined);
	const held = $derived(heldId ? store.messages.find((m) => m.id === heldId) : undefined);
	const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
	let selecting = $state<string | undefined>();
	let pendingSelect: string | undefined;
	let copyNote = $state('');
	const focusAsk = $derived(page.url.searchParams.get('ask') ?? undefined);
	const commandsOffline = $derived(store.workspace === 'offline');
	const empty = $derived(store.history !== 'loading' && store.messages.length === 0);

	const connection = $derived.by((): ConnectionState | 'forbidden' | undefined => {
		if (!pwa.online) return { kind: 'offline' };
		if (store.connection === 'forbidden') return 'forbidden';
		if (store.connection === 'reconnecting' && store.reconnectingSince !== null) {
			const secs = Math.floor((now - store.reconnectingSince) / 1000);
			return { kind: 'reconnecting', elapsed: secs >= 5 ? `${secs}s` : undefined };
		}
		if (store.workspace === 'offline') return { kind: 'agent-offline' };
		if (store.reset) return { kind: 'reset' };
		return undefined;
	});

	// Approve stays locked for a moment whenever a new request reaches the top of the tray or the
	// tray moves. Derived, so a new top request is locked in the same frame it first paints.
	const topNonce = $derived(store.approvals[0]?.nonce);
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

	const tray = $derived(
		store.approvals.length
			? { items: store.approvals, armed, state: store.trayPhase }
			: store.timedOut
				? { items: [store.timedOut], armed: false, state: 'timeout' as const }
				: undefined
	);

	$effect(() => {
		if (store.connection !== 'reconnecting') return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	$effect(() => {
		if (store.history !== 'loading') {
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
		const tail = store.messages.at(-1);
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
				if (!store.hasOlder || store.olderError || store.olderLoading || !olderInView()) break;
				await store.loadOlder();
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

	onMount(() => {
		store.setViewing(true);
		return () => store.setViewing(false);
	});

	onMount(() => {
		if (!focusAsk) return;
		let done = false;
		const stop = $effect.root(() => {
			$effect(() => {
				const item = store.items.find((i) => i.kind === 'ask' && i.askId === focusAsk);
				if (!item || done) return;
				done = true;
				void tick().then(() =>
					document
						.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)
						?.scrollIntoView({ block: 'center' })
				);
			});
		});
		return stop;
	});

	function openSheet(next: NonNullable<App.PageState['sheet']>, messageId?: string) {
		const state = messageId ? { sheet: next, messageId } : { sheet: next };
		if (sheet) replaceState('', state);
		else pushState('', state);
	}

	const messageEl = (id: string) =>
		document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);

	function openMessageMenu(id: string) {
		selecting = undefined;
		if (heldId === id) return;
		// Focus returns here when the sheet closes, whether a hold or the button opened it.
		messageEl(id)?.querySelector<HTMLElement>('[data-message-focus]')?.focus({
			preventScroll: true
		});
		openSheet('message', id);
	}

	async function copyHeld() {
		if (!held) return;
		const text = messagePlainText(held, location.origin);
		closeSheet();
		copyNote = '';
		try {
			if (!navigator.clipboard) throw new Error('no clipboard');
			await navigator.clipboard.writeText(text);
			copyNote = 'Copied';
		} catch {
			copyNote = "Couldn't copy";
		}
	}

	function shareHeld() {
		if (!held) return;
		// Called before closing, while the tap's user activation still counts.
		navigator.share({ text: messagePlainText(held, location.origin) }).catch(() => {});
		closeSheet();
	}

	function selectHeld() {
		if (!held) return;
		selecting = pendingSelect = held.id;
		closeSheet();
	}

	function resendHeld(action: 'retry' | 'discard') {
		if (!held) return;
		const id = held.id;
		closeSheet();
		if (action === 'retry') store.retry(id);
		else void store.discard(id);
	}

	// Select mode waits for the sheet to close, since focus returning to the opener comes first.
	$effect(() => {
		if (sheet || !pendingSelect) return;
		const id = pendingSelect;
		pendingSelect = undefined;
		void tick().then(() => {
			const parts = messageEl(id)?.querySelectorAll('[data-message-text]');
			const sel = document.getSelection();
			if (!parts?.length || !sel) return;
			const range = document.createRange();
			range.setStartBefore(parts[0]);
			range.setEndAfter(parts[parts.length - 1]);
			sel.removeAllRanges();
			sel.addRange(range);
		});
	});

	$effect(() => {
		const id = selecting;
		if (!id) return;
		const leave = (e: PointerEvent) => {
			if (
				!(e.target instanceof Element) ||
				!e.target.closest(`[data-message-id="${CSS.escape(id)}"]`)
			)
				selecting = undefined;
		};
		document.addEventListener('pointerdown', leave, { capture: true });
		return () => document.removeEventListener('pointerdown', leave, { capture: true });
	});

	$effect(() => {
		if (!copyNote) return;
		const t = setTimeout(() => (copyNote = ''), 3000);
		return () => clearTimeout(t);
	});
	function closeSheet() {
		if (sheet) history.back();
	}

	function send() {
		void store.send(store.draft);
		toBottom();
	}

	async function runCommand(c: 'new' | 'compact' | 'stop') {
		closeSheet();
		if (c === 'stop') await store.stopTurn();
		else await store.command(c);
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
			note: store.running ? 'Stop the turn that is running now.' : 'Nothing is running right now.',
			disabled: commandsOffline || !store.running
		},
		{
			id: 'compact' as const,
			icon: FoldVertical,
			label: 'Compact',
			note: 'Summarize older messages so the agent has room to work.',
			disabled: commandsOffline
		}
	]);
	const sheetLabels = {
		commands: 'Chat commands',
		new: 'Start a new chat',
		viewer: 'Image',
		message: 'Message actions'
	};
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && sheet) closeSheet();
	}}
/>

{#snippet sheetBody()}
	{#if sheet === 'commands'}
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
							onclick={() => (c.id === 'new' ? openSheet('new') : runCommand(c.id))}
							class="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-55"
						>
							<c.icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="flex flex-col gap-0.5">
								<span class="text-[15px] font-medium">{c.label}</span>
								<span class="text-sm text-muted-foreground">{c.note}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{:else if sheet === 'new'}
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
	{:else if sheet === 'message' && held}
		<MessageSheet
			message={held}
			preview={messagePlainText(held).slice(0, 200)}
			{canShare}
			oncopy={copyHeld}
			onshare={shareHeld}
			onselect={selectHeld}
			onretry={() => resendHeld('retry')}
			ondelete={() => resendHeld('discard')}
		/>
	{:else if sheet === 'viewer' && viewer?.src}
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
	{/if}
{/snippet}

{#snippet subtitle()}
	<span class="text-xs text-muted-foreground">
		{#if store.running}The agent is working{:else}Your agent{/if}
	</span>
{/snippet}

{#snippet actions()}
	<Button
		variant="ghost"
		class="size-12 px-0"
		aria-label="Chat commands"
		onclick={() => openSheet('commands')}><EllipsisVertical class="size-5" /></Button
	>
	<a
		href={resolve('/settings')}
		aria-label="Settings"
		class="grid size-12 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
	>
		<Settings class="size-5" aria-hidden="true" />
	</a>
{/snippet}

{#snippet banner()}
	{#if connection === 'forbidden'}
		<p
			role="status"
			class="flex items-start gap-2.5 border-b bg-failed-soft px-4 py-2.5 text-sm text-failed"
		>
			<ShieldOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<span>This device isn't signed in as the owner. Check Tailscale, then reopen the app.</span>
		</p>
	{:else if connection}
		<ConnectionBanner state={connection} />
	{/if}
{/snippet}

{#snippet toast()}
	{#if store.toast}{store.toast}{:else}<UpdateToast />{/if}
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
		{#if tray}
			<ApprovalTray
				{...tray}
				onapprove={(nonce) => store.decide(nonce, 'approve')}
				ondeny={(nonce) => store.decide(nonce, 'deny')}
			/>
		{/if}
		<Composer
			bind:value={() => store.draft, (v) => store.setDraft(v)}
			running={store.running}
			stopping={store.stopping}
			stop={!tray}
			photos={store.photos}
			quotaFull={store.quotaFull}
			onsend={send}
			onstop={() => store.stopTurn()}
			onattach={(files) => void store.attach(files)}
			onremovephoto={(id) => store.removePhoto(id)}
			onretryphoto={(id) => store.retryPhoto(id)}
		/>
	</div>
{/snippet}

<AppShell
	active="home"
	title="Main"
	{subtitle}
	{actions}
	{banner}
	{footer}
	toast={store.toast || pwa.waiting ? toast : undefined}
	sheet={sheet ? sheetBody : undefined}
	sheetLabel={sheet ? sheetLabels[sheet] : undefined}
	sheetOnDesktop={sheet === 'message'}
	tabBar={false}
	onclosesheet={closeSheet}
	stickToBottom={!empty}
	bind:scroller
>
	{#if empty}
		<div class="mx-auto flex h-full max-w-2xl flex-col gap-6 px-4 py-6">
			<InstallHint />
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
			<div class="px-4 pt-4"><InstallHint /></div>
			{#if store.hasOlder && !store.olderError}
				<div bind:this={older} class="flex justify-center px-4 pt-2">
					<Button variant="ghost" disabled={store.olderLoading} onclick={() => store.loadOlder()}>
						{#if store.olderLoading}<LoaderCircle
								class="animate-spin motion-reduce:animate-none"
								aria-hidden="true"
							/>Loading earlier messages…{:else}<ChevronUp />Show earlier messages{/if}
					</Button>
				</div>
			{/if}
			{#if store.history === 'loading' && slowLoad && !store.messages.length}
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
				messages={store.messages}
				{focusAsk}
				onopenfile={(f) => {
					viewer = f;
					openSheet('viewer');
				}}
				onretrysend={(id) => store.retry(id)}
				ondeletesend={(id) => void store.discard(id)}
				onanswer={(askId, answer) => store.answer(askId, answer)}
				onretryhistory={() => store.retryHistory()}
				onmessagemenu={openMessageMenu}
				pressed={heldId}
				{selecting}
			/>
		</div>
	{/if}
	<p role="status" class="sr-only">{store.announce}</p>
	<p role="status" class="sr-only">{copyNote}</p>
</AppShell>
