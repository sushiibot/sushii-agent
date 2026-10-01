<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { McpServerScreen, connectorsStore } from '$lib/features/connectors';

	const connectors = connectorsStore();
	const goBack = backTo(resolve('/connectors'));
	const id = $derived(page.params.id ?? '');
	const remote = $derived(connectors.server(id));
	// Said once, on arrival from the add flow.
	const justConnected = untrack(() => connectors.justConnected === page.params.id);
	connectors.justConnected = null;
	let now = $state(Date.now());

	$effect(() => {
		const r = remote;
		untrack(() => void r.ensure());
	});
</script>

<svelte:head><title>{remote.data?.name ?? 'Server'} · sushii</title></svelte:head>

<McpServerScreen
	{remote}
	server={remote.data}
	{now}
	back={{ href: resolve('/connectors'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	{justConnected}
	busy={connectors.busy}
	error={connectors.error}
	runHref={(run) => resolve('/runs/[id]', { id: run })}
	signInHref={resolve('/connectors/add') + '?url=' + encodeURIComponent(remote.data?.url ?? '')}
	onreconnect={() => void connectors.action(id, 'reconnect')}
	ondisconnect={() => void connectors.action(id, 'disconnect')}
	onremove={async () => {
		if (await connectors.action(id, 'remove'))
			await goto(resolve('/connectors'), { replaceState: true });
	}}
	onaccept={() => void connectors.acceptTools(id)}
	onretry={() => void remote.refetch()}
/>
