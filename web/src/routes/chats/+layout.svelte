<script lang="ts">
	import { features } from '$lib/core/features.svelte';
	import { featureGate } from '$lib/core/nav/gate.svelte';

	let { children } = $props();
	const allowed = featureGate('threads');
</script>

{#if allowed() && features.has('threads')}{@render children()}{/if}
