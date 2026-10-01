<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { routedSheet } from '$lib/core/nav/sheet';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import type { ChatSheet, FileRef } from '$lib/features/chat';
	import {
		ThreadScreen,
		threadMessages,
		threadsStore,
		type ThreadSheet
	} from '$lib/features/threads';

	const threads = threadsStore();
	const goBack = backTo(resolve('/chats'));
	const id = $derived(page.params.id ?? '');
	const remote = $derived(threads.thread(id));
	const detail = $derived(remote.data);
	const store = $derived(detail ? threads.chat(detail) : null);
	let viewer = $state<FileRef | undefined>();
	let now = $state(Date.now());

	$effect(() => {
		const r = remote;
		untrack(() => void r.ensure());
	});
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	$effect(() => {
		const s = store;
		if (!s) return;
		untrack(() => s.setViewing(true));
		return () => s.setViewing(false);
	});

	type AnySheet = ChatSheet | Exclude<ThreadSheet, 'branch'>;
	const ids: AnySheet[] = ['commands', 'new', 'viewer', 'usage', 'thread-memory', 'thread-close'];
	const sheets = Object.fromEntries(ids.map((s) => [s, routedSheet(s)])) as Record<
		AnySheet,
		ReturnType<typeof routedSheet>
	>;
	const sheet = $derived(ids.find((s) => sheets[s].open));
	const closeSheet = () => {
		if (sheet) sheets[sheet].close();
	};

	async function closeThread() {
		if (!(await threads.close(id))) return;
		const popped = new Promise((r) => addEventListener('popstate', r, { once: true }));
		closeSheet();
		await popped;
		// The closed thread is gone from the way back, so back from Main lands on Chats.
		await goto(resolve('/chat'), { replaceState: true });
	}
</script>

<svelte:head><title>{detail?.summary.title ?? 'Thread'} · Agent</title></svelte:head>

<ThreadScreen
	{remote}
	{detail}
	{now}
	{sheet}
	busy={threads.busy}
	error={threads.error}
	sendable={threads.canSend}
	back={{ href: resolve('/chats'), label: 'Back to Chats', onclick: goBack }}
	writeHref={(w) => resolve('/memory/writes/[id]', { id: w })}
	memoryHref={resolve('/memory/writes')}
	chat={store
		? {
				messages: threadMessages(detail!, store.messages),
				history: store.history,
				hasOlder: store.hasOlder,
				olderLoading: store.olderLoading,
				olderError: store.olderError,
				running: store.running,
				stopping: store.stopping,
				draft: store.draft,
				photos: store.photos,
				quotaFull: store.quotaFull,
				usage: store.usage,
				connection: pwa.online ? undefined : { kind: 'offline' },
				toast: store.toast,
				announce: store.announce,
				viewer,
				settingsHref: resolve('/settings'),
				onopensheet: (s) => sheets[s].openWith(),
				onclosesheet: closeSheet,
				onopenfile: (f) => {
					viewer = f;
					sheets.viewer.openWith();
				},
				ondraft: (v) => store.setDraft(v),
				onsend: () => void store.send(store.draft),
				onstop: () => store.stopTurn(),
				oncommand: (c) => store.command(c),
				onattach: (files) => void store.attach(files),
				onremovephoto: (p) => store.removePhoto(p),
				onretryphoto: (p) => store.retryPhoto(p),
				onloadolder: () => store.loadOlder(),
				onretryhistory: () => store.retryHistory(),
				onretrysend: (m) => store.retry(m),
				ondeletesend: (m) => void store.discard(m),
				onanswer: (askId, answer) => store.answer(askId, answer)
			}
		: undefined}
	onopensheet={(s) => {
		threads.clearError();
		if (s !== 'branch') sheets[s].openWith();
	}}
	onclosesheet={closeSheet}
	onclose={() => void closeThread()}
	onreopen={() => void threads.reopen(id)}
	onretry={() => void remote.refetch()}
/>
