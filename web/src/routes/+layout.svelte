<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { pwa } from '$lib/app/pwa.svelte';
	import { markBooted } from '$lib/app/boot-recovery';

	let { children } = $props();

	onMount(() => {
		markBooted();
		pwa.start();
	});
</script>

<svelte:head><link rel="icon" href={favicon} type="image/svg+xml" /></svelte:head>

<div class="h-dvh">{@render children()}</div>
