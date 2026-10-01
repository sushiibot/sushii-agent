<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import { features } from '$lib/core/features.svelte';
	import { activeTab, navFor, showsTabBar, tabsFor } from '$lib/core/nav/tabs';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { markBooted } from '$lib/core/pwa/boot-recovery';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import { needsYou } from '$lib/features/home';
	import Shell from '$lib/ui/shell/shell.svelte';

	let { children } = $props();

	// Before any route renders, so a cold deep link to any screen has live data.
	hub.start();
	// Listens from the start, so the Home badge counts what waits whatever screen is open.
	const home = needsYou();
	home.start();

	onMount(() => {
		markBooted();
		pwa.start();
		return features.start();
	});
</script>

<svelte:head><link rel="icon" href={favicon} type="image/svg+xml" /></svelte:head>

<div class="h-dvh">
	<Shell
		nav={navFor(features.has)}
		tabs={tabsFor(features.has)}
		active={activeTab(page.route.id)}
		tabBar={showsTabBar(page.route.id)}
		badges={{ home: home.waitingCount }}>{@render children()}</Shell
	>
</div>
