<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import { activeTab, nav, tabs } from '$lib/core/nav/tabs';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { markBooted } from '$lib/core/pwa/boot-recovery';
	import Shell from '$lib/ui/shell/shell.svelte';

	let { children } = $props();

	onMount(() => {
		markBooted();
		pwa.start();
	});
</script>

<svelte:head><link rel="icon" href={favicon} type="image/svg+xml" /></svelte:head>

<div class="h-dvh">
	<Shell {nav} {tabs} active={activeTab(page.route.id)} tabBar={false}>{@render children()}</Shell>
</div>
