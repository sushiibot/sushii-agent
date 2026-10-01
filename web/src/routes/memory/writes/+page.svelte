<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { MemoryWritesScreen, memoryStore } from '$lib/features/memory';

	const overview = memoryStore().overview;
	const goBack = backTo(resolve('/memory'));
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
</script>

<svelte:head><title>Memory changes · Agent</title></svelte:head>

<MemoryWritesScreen
	remote={overview}
	writes={overview.data?.writes ?? []}
	{now}
	back={{ href: resolve('/memory'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	writeHref={(id) => resolve('/memory/writes/[id]', { id })}
	onretry={() => void overview.refetch()}
/>
