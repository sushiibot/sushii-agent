<script lang="ts">
	import { previewGate } from '$lib/core/nav/gate.svelte';

	let { children } = $props();
	const allowed = previewGate('browser');
</script>

{#if allowed()}{@render children()}{/if}
