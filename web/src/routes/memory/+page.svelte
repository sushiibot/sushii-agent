<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { keepScroll } from '$lib/core/nav/scroll';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { MemoryScreen, memoryStore } from '$lib/features/memory';

	const memory = memoryStore();
	const overview = memory.overview;
	const goBack = backTo(resolve('/more'));
	let now = $state(Date.now());

	onMount(() => {
		void overview.ensure();
		const unwatch = overview.watch();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => {
			clearInterval(t);
			unwatch();
		};
	});
	keepScroll('memory', () => document.querySelector('main'));
</script>

<svelte:head><title>Memory · Agent</title></svelte:head>

<MemoryScreen
	remote={overview}
	data={overview.data}
	{now}
	back={{ href: resolve('/more'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	writeHref={(id) => resolve('/memory/writes/[id]', { id })}
	fileHref={(id) => resolve('/memory/files/[id]', { id })}
	writesHref={resolve('/memory/writes')}
	onretry={() => void overview.refetch()}
/>
