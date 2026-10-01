<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { JobScreen, schedulesStore } from '$lib/features/schedules';

	const schedules = schedulesStore();
	const goBack = backTo(resolve('/schedules'));
	const id = $derived(page.params.id ?? '');
	const remote = $derived(schedules.job(id));
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

<svelte:head><title>{remote.data?.name ?? 'Job'} · Agent</title></svelte:head>

<JobScreen
	{remote}
	job={remote.data}
	{now}
	back={{ href: resolve('/schedules'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	busy={schedules.busy}
	error={schedules.error}
	test={schedules.tests[id]}
	runHref={(run) => resolve('/runs/[id]', { id: run })}
	ontoggle={(on) => void schedules.setEnabled(id, on)}
	ontest={() => void schedules.testRun(id)}
	onretry={() => void remote.refetch()}
/>
