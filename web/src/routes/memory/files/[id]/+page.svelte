<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { MemoryFileScreen, memoryStore } from '$lib/features/memory';

	const memory = memoryStore();
	const goBack = backTo(resolve('/memory'));
	const id = $derived(page.params.id ?? '');
	const remote = $derived(memory.file(id));
	let now = $state(Date.now());

	$effect(() => {
		const r = remote;
		untrack(() => void r.ensure());
	});
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>Memory file · Agent</title></svelte:head>

<MemoryFileScreen
	{remote}
	detail={remote.data}
	{now}
	back={{ href: resolve('/memory'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	writeHref={(w) => resolve('/memory/writes/[id]', { id: w })}
	onretry={() => void remote.refetch()}
/>
