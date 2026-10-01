<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { keepScroll } from '$lib/core/nav/scroll';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { SkillsScreen, skillsStore } from '$lib/features/skills';

	const list = skillsStore().list;
	const goBack = backTo(resolve('/more'));
	let now = $state(Date.now());

	onMount(() => {
		void list.ensure();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	keepScroll('skills', () => document.querySelector('main'));
</script>

<svelte:head><title>Skills · Agent</title></svelte:head>

<SkillsScreen
	remote={list}
	skills={list.data ?? []}
	{now}
	back={{ href: resolve('/more'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	skillHref={(name) => resolve('/skills/[name]', { name })}
	onretry={() => void list.refetch()}
/>
