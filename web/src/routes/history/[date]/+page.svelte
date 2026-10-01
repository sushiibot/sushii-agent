<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { DATE_RE, HistoryDayScreen, historyStore } from '$lib/features/history';

	const history = historyStore();
	const goBack = backTo(resolve('/history'));
	const date = $derived(page.params.date ?? '');
	const valid = $derived(DATE_RE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)));
	const remote = $derived(valid ? history.day(date) : null);
	let now = $state(Date.now());

	$effect(() => {
		const r = remote;
		untrack(() => void r?.ensure());
	});
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>History · Agent</title></svelte:head>

<HistoryDayScreen
	{date}
	remote={remote ?? { status: 'ready' }}
	detail={remote ? remote.data : { found: false }}
	{now}
	back={{ href: resolve('/history'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	runHref={(id) => resolve('/runs/[id]', { id })}
	onretry={() => void remote?.refetch()}
/>
