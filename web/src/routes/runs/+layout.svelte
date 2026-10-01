<script lang="ts">
	import { featureGate } from '$lib/core/nav/gate.svelte';

	let { children } = $props();
	const allowed = featureGate('runs');
</script>

{#if allowed()}{@render children()}{/if}
