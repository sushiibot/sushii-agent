<script lang="ts">
	import { onMount } from 'svelte';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { BriefingScreen, briefingStore } from '$lib/features/briefing';

	const briefing = briefingStore();
	const today = briefing.today;
	let now = $state(Date.now());

	onMount(() => {
		void today.ensure();
		const unwatch = today.watch();
		const t = setInterval(() => (now = Date.now()), 60_000);
		return () => {
			clearInterval(t);
			unwatch();
		};
	});
</script>

<svelte:head><title>Briefing · Agent</title></svelte:head>

<BriefingScreen
	remote={today}
	briefing={today.data}
	{now}
	online={pwa.online}
	error={briefing.error}
	onvote={(id, v) => void briefing.vote(id, v)}
	ondismiss={(id, d) => void briefing.dismiss(id, d)}
	onretry={() => void today.refetch()}
/>
