<script lang="ts">
	import { previewGate } from '$lib/core/nav/gate.svelte';

	let { children } = $props();
	const allowed = previewGate('schedules');
</script>

{#if allowed()}{@render children()}{/if}
