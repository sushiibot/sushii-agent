<script lang="ts">
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { more } from '$lib/core/nav/tabs';
	import { MoreScreen } from '$lib/features/more';
</script>

<svelte:head><title>More · Agent</title></svelte:head>

<MoreScreen
	entries={more}
	online={pwa.online}
	updateReady={!!pwa.waiting}
	onreload={() => pwa.applyUpdate()}
/>
