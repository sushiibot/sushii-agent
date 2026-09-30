<script lang="ts">
	import ClearNotifications from '$lib/features/chat/clear-notifications.svelte';
	import MainChat from '$lib/features/chat/main-chat.svelte';
	import { chatStore } from '$lib/features/chat/session';
</script>

<svelte:head><title>Agent</title></svelte:head>

{#await chatStore() then store}
	<MainChat {store} />
	<ClearNotifications {store} />
{/await}
