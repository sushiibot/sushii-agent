<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { SkillScreen, skillsStore } from '$lib/features/skills';

	const skills = skillsStore();
	const goBack = backTo(resolve('/skills'));
	const name = $derived(page.params.name ?? '');
	const remote = $derived(skills.skill(name));
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

<svelte:head><title>Skill · sushii</title></svelte:head>

<SkillScreen
	{remote}
	skill={remote.data}
	{now}
	back={{ href: resolve('/skills'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	busy={skills.busy}
	error={skills.error}
	runHref={(id) => resolve('/runs/[id]', { id })}
	versionsHref={(n) => resolve('/skills/[name]/versions', { name: n })}
	onsetstage={(stage) => void skills.setStage(name, stage)}
	onretry={() => void remote.refetch()}
/>
