<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { keepScroll } from '$lib/core/nav/scroll';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { HistoryScreen, historyStore } from '$lib/features/history';

	const history = historyStore();
	const days = history.days;
	let now = $state(Date.now());

	onMount(() => {
		void days.ensure();
		const unwatch = days.watch();
		const t = setInterval(() => (now = Date.now()), 60_000);
		return () => {
			clearInterval(t);
			unwatch();
		};
	});
	keepScroll('history', () => document.querySelector('main'));
</script>

<svelte:head><title>History · Agent</title></svelte:head>

<HistoryScreen
	remote={days}
	days={[...(days.data?.days ?? []), ...history.older]}
	{now}
	hasOlder={!!history.before}
	olderLoading={history.olderLoading}
	olderError={history.olderError}
	online={pwa.online}
	dayHref={(date) => resolve('/history/[date]', { date })}
	searchHref={resolve('/history/search')}
	onretry={() => void days.refetch()}
	onloadolder={() => void history.loadOlder()}
/>
