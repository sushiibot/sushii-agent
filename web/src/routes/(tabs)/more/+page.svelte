<script lang="ts">
	import { resolve } from '$app/paths';
	import Screen from '$lib/ui/screen/screen.svelte';
</script>

<svelte:head><title>More · Agent</title></svelte:head>

<Screen title="More">
	<a class="mx-4 my-4 flex h-12 items-center text-sm" href={resolve('/settings')}>Settings</a>
</Screen>
