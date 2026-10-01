<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { SkillVersionsScreen, skillsStore } from '$lib/features/skills';

	const skills = skillsStore();
	const name = $derived(page.params.name ?? '');
	const parent = $derived(resolve('/skills/[name]', { name }));
	const goBack = backTo(resolve('/skills/[name]', { name: page.params.name ?? '' }));
	const remote = $derived(skills.skill(name));
	let now = $state(Date.now());

	$effect(() => {
		const r = remote;
		untrack(() => void r.ensure());
	});
</script>

<svelte:head><title>Skill versions · sushii</title></svelte:head>

<SkillVersionsScreen
	{remote}
	skill={remote.data}
	{now}
	back={{ href: parent, label: 'Back', onclick: goBack }}
	online={pwa.online}
	runHref={(id) => resolve('/runs/[id]', { id })}
	onretry={() => void remote.refetch()}
/>
