<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { BrowserScreen, browserStore } from '$lib/features/browser';

	const browser = browserStore();
	const status = browser.status;
	const goBack = backTo(resolve('/more'));
	let now = $state(Date.now());

	onMount(() => {
		void status.ensure();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>Browser · Agent</title></svelte:head>

<BrowserScreen
	remote={status}
	status={status.data}
	{now}
	back={{ href: resolve('/more'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	pending={browser.pending}
	error={browser.error}
	runHref={(id) => resolve('/runs/[id]', { id })}
	ontakeover={() => void browser.takeOver()}
	onhandback={() => void browser.handBack()}
	onretry={() => void status.refetch()}
/>
