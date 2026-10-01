<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { keepScroll } from '$lib/core/nav/scroll';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { SkillsScreen, skillsStore } from '$lib/features/skills';

	const list = skillsStore().list;
	let now = $state(Date.now());

	onMount(() => {
		void list.ensure();
		const unwatch = list.watch();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => {
			clearInterval(t);
			unwatch();
		};
	});
	keepScroll('skills', () => document.querySelector('main'));
</script>

<svelte:head><title>Skills · Agent</title></svelte:head>

<SkillsScreen
	remote={list}
	skills={list.data ?? []}
	{now}
	online={pwa.online}
	skillHref={(name) => resolve('/skills/[name]', { name })}
	onretry={() => void list.refetch()}
/>
