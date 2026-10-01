<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { features } from '$lib/core/features.svelte';
	import { backTo } from '$lib/core/nav/back';
	import { leaveSheet, routedSheet } from '$lib/core/nav/sheet';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import {
		ChatScreen,
		ClearNotifications,
		chatStore,
		type ChatSheet,
		type ChatTray,
		type ChatMessage,
		type FileRef
	} from '$lib/features/chat';
	import { BranchSheet, threadsStore, withReports } from '$lib/features/threads';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';

	const store = chatStore();
	// With threads, Main sits under the Chats list; without, Chat is a tab that goes back Home.
	const threadsOn = $derived(features.has('threads'));
	const parent = $derived(threadsOn ? resolve('/chats') : resolve('/'));
	const goBackHome = backTo(resolve('/'));
	const goBackChats = backTo(resolve('/chats'));
	const threads = $derived(threadsOn ? threadsStore() : null);
	const branch = routedSheet('branch');
	let branchFrom = $state<{ id: string; quote: string } | null>(null);
	let threadTitle = $state('');
	const s = store;
	let viewer = $state<FileRef | undefined>();
	let now = $state(Date.now());

	const sheets: Record<ChatSheet, ReturnType<typeof routedSheet>> = {
		commands: routedSheet('commands'),
		new: routedSheet('new'),
		viewer: routedSheet('viewer'),
		usage: routedSheet('usage')
	};
	const sheet = $derived((Object.keys(sheets) as ChatSheet[]).find((s) => sheets[s].open));
	const focusAsk = $derived(page.url.searchParams.get('ask') ?? undefined);

	const connection = $derived.by((): ConnectionState | 'forbidden' | undefined => {
		if (!pwa.online) return { kind: 'offline' };
		if (hub.connection === 'forbidden') return 'forbidden';
		if (hub.connection === 'reconnecting' && hub.reconnectingSince !== null) {
			const secs = Math.floor((now - hub.reconnectingSince) / 1000);
			return { kind: 'reconnecting', elapsed: secs >= 5 ? `${secs}s` : undefined };
		}
		if (store.workspace === 'offline') return { kind: 'agent-offline' };
		if (store.reset) return { kind: 'reset' };
		return undefined;
	});

	$effect(() => {
		if (hub.connection !== 'reconnecting') return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	const tray = $derived.by((): ChatTray | undefined => {
		if (store.approvals.length) return { items: store.approvals, state: store.trayPhase };
		if (store.timedOut) return { items: [store.timedOut], armed: false, state: 'timeout' };
		return undefined;
	});

	$effect(() => {
		untrack(() => store.setViewing(true));
		return () => store.setViewing(false);
	});

	// A push for a question opens /?ask=<id>; its card scrolls into view once history has it.
	$effect(() => {
		const askId = untrack(() => focusAsk);
		if (!askId) return;
		let done = false;
		return $effect.root(() => {
			$effect(() => {
				const item = store.items.find((i) => i.kind === 'ask' && i.askId === askId);
				if (!item || done) return;
				done = true;
				void tick().then(() =>
					document
						.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)
						?.scrollIntoView({ block: 'center' })
				);
			});
		});
	});

	function openSheet(next: ChatSheet) {
		sheets[next].openWith();
	}

	function closeSheet() {
		if (sheet) sheets[sheet].close();
	}

	const plain = (m: ChatMessage) =>
		m.parts
			.flatMap((p) => (p.type === 'text' ? [p.text] : []))
			.join(' ')
			.slice(0, 280);

	function openBranch(m: ChatMessage) {
		branchFrom = { id: m.id, quote: plain(m) };
		threadTitle = '';
		threads?.clearError();
		branch.openWith();
	}

	async function startThread(name: string) {
		const id = await threads?.branch(branchFrom?.id ?? '', name);
		if (!id) return;
		await leaveSheet(branch);
		await goto(resolve('/chats/[id]', { id }));
	}
</script>

<svelte:head><title>Chat · Agent</title></svelte:head>

<ChatScreen
	messages={threads ? withReports(s.messages, threads.reports) : s.messages}
	history={s.history}
	hasOlder={s.hasOlder}
	olderLoading={s.olderLoading}
	olderError={s.olderError}
	running={s.running}
	stopping={s.stopping}
	{tray}
	draft={s.draft}
	photos={s.photos}
	quotaFull={s.quotaFull}
	usage={s.usage}
	{connection}
	commandsOffline={s.workspace === 'offline'}
	toast={s.toast}
	updateReady={!!pwa.waiting}
	canInstall={pwa.canInstall}
	announce={s.announce}
	{focusAsk}
	{sheet}
	{viewer}
	settingsHref={resolve('/settings')}
	back={{
		href: parent,
		label: threadsOn ? 'Back to Chats' : 'Back to Home',
		onclick: threadsOn ? goBackChats : goBackHome,
		desktop: false
	}}
	subtitle={threadsOn ? mainSubtitle : undefined}
	onbranch={threadsOn ? openBranch : undefined}
	onopensheet={openSheet}
	onclosesheet={closeSheet}
	onopenfile={(f) => {
		viewer = f;
		openSheet('viewer');
	}}
	ondraft={(v) => s.setDraft(v)}
	onsend={() => void s.send(s.draft)}
	onstop={() => s.stopTurn()}
	oncommand={(c) => s.command(c)}
	onattach={(files) => void s.attach(files)}
	onremovephoto={(id) => s.removePhoto(id)}
	onretryphoto={(id) => s.retryPhoto(id)}
	onloadolder={() => s.loadOlder()}
	onretryhistory={() => s.retryHistory()}
	onretrysend={(id) => s.retry(id)}
	ondeletesend={(id) => void s.discard(id)}
	onanswer={(askId, answer) => s.answer(askId, answer)}
	ondecide={(nonce, decision) => s.decide(nonce, decision)}
	oninstall={() => pwa.install()}
	onreload={() => pwa.applyUpdate()}
/>
<ClearNotifications store={s} />

{#snippet mainSubtitle()}
	<span class="text-xs text-muted-foreground">
		{#if s.running}The agent is working{:else}Threads report back here{/if}
	</span>
{/snippet}

{#if threads}
	<BranchSheet
		open={branch.open}
		quote={branchFrom?.quote}
		bind:title={threadTitle}
		busy={threads.busy}
		error={threads.error}
		onstart={(name) => void startThread(name)}
		onclose={() => branch.close()}
	/>
{/if}
