<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { needsYou } from '$lib/features/home';
	import { RunDetailScreen, runsStore } from '$lib/features/runs';

	const runs = runsStore();
	const goBack = backTo(resolve('/runs'));
	const id = $derived(page.params.id ?? '');
	const view = $derived(runs.run(id));
	let now = $state(Date.now());

	$effect(() => {
		const v = view;
		const runId = id;
		untrack(() => {
			void v.remote.ensure();
			// Opening a finished run takes it off Home's "Ready for review".
			needsYou().markOpened(runId);
		});
		return v.remote.watch();
	});
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
</script>

<svelte:head><title>Run · Agent</title></svelte:head>

<RunDetailScreen
	remote={view.remote}
	detail={view.remote.data}
	steps={[...(view.remote.data?.steps ?? []), ...view.more]}
	{now}
	back={{ href: resolve('/runs'), label: 'Back', onclick: goBack }}
	hasMore={!!view.after}
	moreLoading={view.moreLoading}
	moreError={view.moreError}
	online={pwa.online}
	runHref={(runId) => resolve('/runs/[id]', { id: runId })}
	historyHref={(date) => resolve('/history/[date]', { date })}
	onretry={() => void view.remote.refetch()}
	onloadmore={() => void view.loadMore()}
/>
