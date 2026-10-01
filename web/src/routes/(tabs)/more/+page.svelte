<script lang="ts">
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { features } from '$lib/core/features.svelte';
	import { enabled, more } from '$lib/core/nav/tabs';
	import { MoreScreen } from '$lib/features/more';
</script>

<svelte:head><title>More · Agent</title></svelte:head>

<MoreScreen
	entries={enabled(more, (f) => features.has(f))}
	online={pwa.online}
	updateReady={!!pwa.waiting}
	onreload={() => pwa.applyUpdate()}
/>
