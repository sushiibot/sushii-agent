<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';
	import { features } from '$lib/core/features.svelte';
	import { activeTab, featureOf, navFor, showsTabBar, tabsFor } from '$lib/core/nav/tabs';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { markBooted } from '$lib/core/pwa/boot-recovery';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import { configureChat, createFakeBackend } from '$lib/features/chat';
	import { needsYou } from '$lib/features/home';
	import Shell from '$lib/ui/shell/shell.svelte';

	let { children } = $props();

	// `bun dev` with ?fake drives the whole app from an in-memory bot over the one hub, with every
	// fixture screen on. It sticks for the tab, so a reload on a deep screen stays fake.
	if (import.meta.env.DEV && fakeMode()) {
		const fake = createFakeBackend();
		hub.useTransport(fake.transport);
		configureChat({ api: fake.api });
		features.setOverride('all');
	}
	// Before any route renders, so a cold deep link to any screen has live data.
	hub.start();
	// Listens from the start, so the Home badge counts what waits whatever screen is open.
	const home = needsYou();
	home.start();

	function fakeMode(): boolean {
		try {
			if (new URLSearchParams(location.search).has('fake')) sessionStorage.setItem('fake', '1');
			return sessionStorage.getItem('fake') === '1';
		} catch {
			return new URLSearchParams(location.search).has('fake');
		}
	}

	const on = (f: Parameters<typeof features.has>[0]) => features.has(f);
	const tabs = $derived(tabsFor(on));
	const nav = $derived(navFor(on));

	// A screen whose slice is off goes Home, once the app knows what is on; a cold deep link
	// opened offline before /api/me answers stays put.
	$effect(() => {
		const needs = featureOf(page.route.id);
		if (needs && features.known && !features.has(needs)) void goto('/', { replaceState: true });
	});

	onMount(() => {
		markBooted();
		pwa.start();
		return features.start();
	});
</script>

<svelte:head><link rel="icon" href={favicon} type="image/svg+xml" /></svelte:head>

<div class="h-dvh">
	<Shell
		{nav}
		{tabs}
		active={activeTab(page.route.id)}
		tabBar={showsTabBar(page.route.id)}
		badges={{ home: home.waitingCount }}>{@render children()}</Shell
	>
</div>
