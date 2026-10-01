<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { historyStore, SearchScreen } from '$lib/features/history';

	const search = historyStore().search;
	const goBack = backTo(resolve('/history'));
	const fromLink = page.url.searchParams.get('q');
	if (fromLink !== null && fromLink !== search.query) search.set(fromLink);
	let now = $state(Date.now());

	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(t);
	});

	// The query lives in the URL, so back from a result returns to the same results.
	function setQuery(q: string) {
		search.set(q);
		const url = new URL(page.url);
		if (q) url.searchParams.set('q', q);
		else url.searchParams.delete('q');
		replaceState(url, page.state);
	}
</script>

<svelte:head><title>Search · sushii</title></svelte:head>

<SearchScreen
	bind:query={() => search.query, setQuery}
	status={search.status}
	slow={search.slow}
	error={search.error}
	result={search.result}
	{now}
	back={{ href: resolve('/history'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	autofocus={!search.query}
	runHref={(id) => resolve('/runs/[id]', { id })}
	dayHref={(date) => resolve('/history/[date]', { date })}
	onretry={() => void search.run()}
/>
