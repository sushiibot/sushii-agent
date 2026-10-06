<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { leaveSheet, routedSheet } from '$lib/core/nav/sheet';
	import { keepScroll } from '$lib/core/nav/scroll';
	import { offlineBrowsing } from '$lib/core/storage/offline.svelte';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import {
		BranchSheet,
		ChatsScreen,
		ThreadSettingsSheet,
		threadsStore,
		type ThreadSummary
	} from '$lib/features/threads';

	const threads = threadsStore();
	const list = threads.list;
	const sheet = routedSheet('branch');
	const settings = routedSheet('thread-settings');
	let selected = $state<ThreadSummary>();
	const picked = $derived(list.data?.threads.find((t) => t.id === settings.arg) ?? selected);
	let query = $state('');
	let title = $state('');
	let now = $state(Date.now());

	onMount(() => {
		void list.ensure();
		const unwatch = list.watch();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => {
			clearInterval(t);
			unwatch();
		};
	});
	keepScroll('chats', () => document.querySelector('main'));

	async function start(name: string) {
		const id = await threads.branch('', name);
		if (!id) return;
		await leaveSheet(sheet);
		title = '';
		await goto(resolve('/chats/[id]', { id }));
	}
</script>

<svelte:head><title>Threads · sushii</title></svelte:head>

<ChatsScreen
	remote={list}
	data={list.data}
	{now}
	bind:query
	online={pwa.online && !offlineBrowsing.unreachable}
	updateReady={!!pwa.waiting}
	mainHref={resolve('/chat')}
	threadHref={(id) => resolve('/chats/[id]', { id })}
	onretry={() => void list.refetch()}
	onnew={() => {
		threads.clearError();
		sheet.openWith();
	}}
	onreload={() => pwa.reload()}
	onoptions={(thread) => {
		selected = thread;
		threads.clearError();
		settings.openWith(thread.id);
	}}
/>
<BranchSheet
	open={sheet.open}
	bind:title
	busy={threads.busy}
	error={threads.error}
	onstart={(name) => void start(name)}
	onclose={() => sheet.close()}
/>

<ThreadSettingsSheet
	open={settings.open}
	thread={picked}
	busy={threads.busy}
	error={threads.error}
	onrename={async (title) => {
		if (picked && (await threads.rename(picked.id, title))) await leaveSheet(settings);
	}}
	onarchive={async () => {
		if (picked && (await threads.close(picked.id))) await leaveSheet(settings);
	}}
	onclose={() => settings.close()}
/>
