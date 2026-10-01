<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import { features } from '$lib/core/features.svelte';
	import { activeNav, navFor } from '$lib/core/nav/nav';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { markBooted } from '$lib/core/pwa/boot-recovery';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import { needsYou } from '$lib/features/home';
	import Shell from '$lib/ui/shell/shell.svelte';

	let { children } = $props();

	// Before any route renders, so a cold deep link to any screen has live data.
	hub.start();
	// Listens from the start, so the inbox badge counts what waits whatever screen is open.
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
		active={activeNav(page.route.id)}
		badges={{ inbox: home.waitingCount || home.unreadCount > 0 }}>{@render children()}</Shell
	>
</div>
