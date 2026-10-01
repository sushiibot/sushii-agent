<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head
	><link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32" /></svelte:head
>
{@render children()}
