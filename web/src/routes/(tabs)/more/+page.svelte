<script lang="ts">
	import { features } from '$lib/core/features.svelte';
	import { moreFor } from '$lib/core/nav/tabs';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { MoreScreen } from '$lib/features/more';

	const entries = $derived(moreFor((f) => features.has(f)));
</script>

<svelte:head><title>More · Agent</title></svelte:head>

<MoreScreen
	{entries}
	online={pwa.online}
	updateReady={!!pwa.waiting}
	onreload={() => pwa.applyUpdate()}
/>
