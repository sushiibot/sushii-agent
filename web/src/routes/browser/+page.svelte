<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { BrowserScreen, browserStore } from '$lib/features/browser';

	const browser = browserStore();
	const status = browser.status;
	let now = $state(Date.now());

	onMount(() => {
		void status.ensure();
		const unwatch = status.watch();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => {
			clearInterval(t);
			unwatch();
		};
	});
</script>

<svelte:head><title>Browser · sushii</title></svelte:head>

<BrowserScreen
	remote={status}
	status={status.data}
	{now}
	online={pwa.online}
	pending={browser.pending}
	error={browser.error}
	runHref={(id) => resolve('/runs/[id]', { id })}
	ontakeover={() => void browser.takeOver()}
	onhandback={() => void browser.handBack()}
	onretry={() => void status.refetch()}
/>
