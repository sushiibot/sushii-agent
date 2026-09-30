<script lang="ts">
	import { onMount } from 'svelte';
	import type { ChatStore } from '$lib/chat/store.svelte';
	import { closeShownNotifications, tagsShownBy } from './notifications';

	let { store }: { store: ChatStore } = $props();

	// Coming back to an app left open counts as opening it.
	let visible = $state(true);
	onMount(() => {
		const sync = () => (visible = document.visibilityState === 'visible');
		sync();
		document.addEventListener('visibilitychange', sync);
		return () => document.removeEventListener('visibilitychange', sync);
	});

	$effect(() => {
		if (!store.viewing || !visible) return;
		const tags = tagsShownBy(store.items, store.approvals);
		void closeShownNotifications(tags).catch(() => {
			// Nothing to clear if the worker is gone; the next visit tries again.
		});
	});
</script>
