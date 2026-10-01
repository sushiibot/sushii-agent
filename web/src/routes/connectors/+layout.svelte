<script lang="ts">
	import { featureGate } from '$lib/core/nav/gate.svelte';

	let { children } = $props();
	featureGate('connectors');
</script>

{@render children()}
