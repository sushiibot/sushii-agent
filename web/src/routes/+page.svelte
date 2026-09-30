<script lang="ts">
	import ClearNotifications from '$lib/app/clear-notifications.svelte';
	import MainChat from '$lib/chat/main-chat.svelte';
	import { chatStore } from '$lib/chat/session';
</script>

<svelte:head><title>Agent</title></svelte:head>

{#await chatStore() then store}
	<MainChat {store} />
	<ClearNotifications {store} />
{/await}
