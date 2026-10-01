<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { routedSheet } from '$lib/core/nav/sheet';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import {
		ChatScreen,
		ClearNotifications,
		chatStore,
		type ChatSheet,
		type ChatTray,
		type FileRef
	} from '$lib/features/chat';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';

	const store = chatStore();
	const goBack = backTo(resolve('/'));
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
</script>

<svelte:head><title>Chat · Agent</title></svelte:head>

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
	back={{ href: resolve('/'), label: 'Back to Home', onclick: goBack }}
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
