<script lang="ts">
	import { featureGate } from '$lib/core/nav/gate.svelte';

	let { children } = $props();
	featureGate('history');
</script>

{@render children()}
