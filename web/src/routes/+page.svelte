<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import {
		ChatScreen,
		ClearNotifications,
		chatStore,
		type ChatSheet,
		type ChatStore,
		type ChatTray,
		type FileRef
	} from '$lib/features/chat';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';

	let store = $state.raw<ChatStore | null>(null);
	let viewer = $state<FileRef | undefined>();
	let now = $state(Date.now());

	void chatStore().then((s) => (store = s));

	const sheet = $derived(page.state.sheet);
	const heldId = $derived(sheet === 'message' ? page.state.messageId : undefined);
	const focusAsk = $derived(page.url.searchParams.get('ask') ?? undefined);

	const connection = $derived.by((): ConnectionState | 'forbidden' | undefined => {
		if (!pwa.online) return { kind: 'offline' };
		if (!store) return undefined;
		if (store.connection === 'forbidden') return 'forbidden';
		if (store.connection === 'reconnecting' && store.reconnectingSince !== null) {
			const secs = Math.floor((now - store.reconnectingSince) / 1000);
			return { kind: 'reconnecting', elapsed: secs >= 5 ? `${secs}s` : undefined };
		}
		if (store.workspace === 'offline') return { kind: 'agent-offline' };
		if (store.reset) return { kind: 'reset' };
		return undefined;
	});

	$effect(() => {
		if (store?.connection !== 'reconnecting') return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	const tray = $derived.by((): ChatTray | undefined => {
		if (!store) return undefined;
		if (store.approvals.length) return { items: store.approvals, state: store.trayPhase };
		if (store.timedOut) return { items: [store.timedOut], armed: false, state: 'timeout' };
		return undefined;
	});

	$effect(() => {
		const s = store;
		if (!s) return;
		untrack(() => s.setViewing(true));
		return () => s.setViewing(false);
	});

	// A push for a question opens /?ask=<id>; its card scrolls into view once history has it.
	$effect(() => {
		const s = store;
		const askId = untrack(() => focusAsk);
		if (!s || !askId) return;
		let done = false;
		return $effect.root(() => {
			$effect(() => {
				const item = s.items.find((i) => i.kind === 'ask' && i.askId === askId);
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

	function openSheet(next: ChatSheet, messageId?: string) {
		const state = messageId ? { sheet: next, messageId } : { sheet: next };
		if (sheet) replaceState('', state);
		else pushState('', state);
	}

	function closeSheet() {
		if (sheet) history.back();
	}
</script>

<svelte:head><title>Agent</title></svelte:head>

{#if store}
	{@const s = store}
	<ChatScreen
		messages={s.messages}
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
		{connection}
		commandsOffline={s.workspace === 'offline'}
		toast={s.toast}
		updateReady={!!pwa.waiting}
		canInstall={pwa.canInstall}
		announce={s.announce}
		{focusAsk}
		{sheet}
		{heldId}
		{viewer}
		settingsHref={resolve('/settings')}
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
{/if}
