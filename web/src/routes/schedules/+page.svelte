<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { keepScroll } from '$lib/core/nav/scroll';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { SchedulesScreen, schedulesStore } from '$lib/features/schedules';

	const list = schedulesStore().list;
	const goBack = backTo(resolve('/more'));
	let now = $state(Date.now());

	onMount(() => {
		void list.ensure();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	keepScroll('schedules', () => document.querySelector('main'));
</script>

<svelte:head><title>Schedules · Agent</title></svelte:head>

<SchedulesScreen
	remote={list}
	jobs={list.data ?? []}
	{now}
	back={{ href: resolve('/more'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	jobHref={(id) => resolve('/schedules/[id]', { id })}
	onretry={() => void list.refetch()}
/>
