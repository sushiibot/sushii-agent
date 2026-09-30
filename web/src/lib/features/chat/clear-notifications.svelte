<script lang="ts">
	import { onMount } from 'svelte';
	import type { ChatStore } from './store.svelte';
	import { closeShownNotifications } from '$lib/core/pwa/notifications';
	import { tagsShownBy } from './notifications';

	let { store }: { store: ChatStore } = $props();

	// Coming back to an app left open counts as opening it.
	let visible = $state(true);
	onMount(() => {
		const sync = () => (visible = document.visibilityState === 'visible');
		sync();
		document.addEventListener('visibilitychange', sync);
		return () => document.removeEventListener('visibilitychange', sync);
	});

	// Keyed on the tag set, so a streaming reply's frames don't each reach the worker.
	const tagKey = $derived(
		[...tagsShownBy(store.conversationId, store.items, store.approvals)].sort().join('\n')
	);

	$effect(() => {
		if (!store.viewing || !visible) return;
		void closeShownNotifications(new Set(tagKey.split('\n'))).catch(() => {
			// Nothing to clear if the worker is gone; the next visit tries again.
		});
	});
</script>
