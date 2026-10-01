<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { routedSheet } from '$lib/core/nav/sheet';
	import { keepScroll } from '$lib/core/nav/scroll';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { BranchSheet, ChatsScreen, threadsStore } from '$lib/features/threads';

	const threads = threadsStore();
	const list = threads.list;
	const sheet = routedSheet('branch');
	let query = $state('');
	let title = $state('');
	let now = $state(Date.now());

	onMount(() => {
		void list.ensure();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	keepScroll('chats', () => document.querySelector('main'));

	async function start(name: string) {
		const id = await threads.branch('', name);
		if (!id) return;
		const popped = new Promise((r) => addEventListener('popstate', r, { once: true }));
		sheet.close();
		await popped;
		title = '';
		await goto(resolve('/chats/[id]', { id }));
	}
</script>

<svelte:head><title>Chats · Agent</title></svelte:head>

<ChatsScreen
	remote={list}
	data={list.data}
	{now}
	bind:query
	online={pwa.online}
	updateReady={!!pwa.waiting}
	mainHref={resolve('/chat')}
	threadHref={(id) => resolve('/chats/[id]', { id })}
	onretry={() => void list.refetch()}
	onnew={() => {
		threads.clearError();
		sheet.openWith();
	}}
	onreload={() => pwa.applyUpdate()}
/>
<BranchSheet
	open={sheet.open}
	bind:title
	busy={threads.busy}
	error={threads.error}
	onstart={(name) => void start(name)}
	onclose={() => sheet.close()}
/>
