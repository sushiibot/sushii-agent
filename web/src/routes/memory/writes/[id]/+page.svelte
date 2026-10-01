<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { MemoryWriteScreen, memoryStore } from '$lib/features/memory';

	const memory = memoryStore();
	const goBack = backTo(resolve('/memory'));
	const id = $derived(page.params.id ?? '');
	const remote = $derived(memory.write(id));
	let now = $state(Date.now());

	$effect(() => {
		const r = remote;
		untrack(() => {
			memory.clearResult();
			void r.ensure();
		});
	});
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	// The toast is a note, not a decision, so it may go away on its own.
	$effect(() => {
		if (!memory.result) return;
		const t = setTimeout(() => memory.clearResult(), 8000);
		return () => clearTimeout(t);
	});
</script>

<svelte:head><title>Memory change · sushii</title></svelte:head>

<MemoryWriteScreen
	{remote}
	write={remote.data}
	{now}
	back={{ href: resolve('/memory'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	busy={memory.busy}
	result={memory.result?.id === id ? memory.result : null}
	runHref={(run) => resolve('/runs/[id]', { id: run })}
	threadHref={(t) => resolve('/chats/[id]', { id: t })}
	fileHref={(f) => resolve('/memory/files/[id]', { id: f })}
	onrevert={() => void memory.revert(id)}
	onrestore={() => void memory.restore(id)}
	onretry={() => void remote.refetch()}
/>
