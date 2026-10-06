<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { features } from '$lib/core/features.svelte';
	import { previousPathIs } from '$lib/core/nav/back';
	import { activeNav, navFor } from '$lib/core/nav/nav';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { markBooted } from '$lib/core/pwa/boot-recovery';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import { send } from '$lib/core/http';
	import { threadsStore } from '$lib/features/threads';
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
		void threadsStore().list.ensure();
		if (page.url.pathname !== '/chat') {
			void send('GET', '/chat/history?limit=40').catch(() => {});
		}
		return features.start();
	});
</script>

<svelte:head
	><link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32" /></svelte:head
>

<div class="h-dvh">
	<Shell
		nav={navFor(features.has)}
		active={activeNav(page.route.id)}
		navigationKey={page.url.pathname + page.url.search}
		home="chats"
		badges={{ chats: home.needsYouCount || home.unreadCount > 0 }}
		onhome={(e) => {
			// Back to the conversations entry already under this one, rather than stacking a second.
			if (!previousPathIs('/chats')) return;
			e.preventDefault();
			history.back();
		}}>{@render children()}</Shell
	>
</div>
