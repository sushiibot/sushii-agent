<script lang="ts">
	import MainChat from '$lib/chat/main-chat.svelte';
	import { chatStore } from '$lib/chat/session';
</script>

<svelte:head><title>Agent</title></svelte:head>

{#await chatStore() then store}
	<MainChat {store} />
{/await}
