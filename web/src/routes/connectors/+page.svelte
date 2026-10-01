<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { backTo } from '$lib/core/nav/back';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { ConnectorsScreen, connectorsStore } from '$lib/features/connectors';

	const list = connectorsStore().list;
	const goBack = backTo(resolve('/more'));
	onMount(() => void list.ensure());
</script>

<svelte:head><title>Connectors · Agent</title></svelte:head>

<ConnectorsScreen
	remote={list}
	servers={list.data ?? []}
	back={{ href: resolve('/more'), label: 'Back', onclick: goBack }}
	online={pwa.online}
	serverHref={(id) => resolve('/connectors/[id]', { id })}
	addHref={resolve('/connectors/add')}
	onretry={() => void list.refetch()}
/>
