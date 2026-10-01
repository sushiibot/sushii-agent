<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Screen from '$lib/ui/screen/screen.svelte';

	// An address the app doesn't have goes Home rather than to a dead end.
	$effect(() => {
		if (page.status === 404) void goto(resolve('/'), { replaceState: true });
	});
</script>

<svelte:head><title>Agent</title></svelte:head>

<Screen title="Agent">
	<div class="mx-auto flex max-w-2xl flex-col items-start gap-3 px-4 py-6">
		{#if page.status === 404}
			<p role="status" class="text-sm text-muted-foreground">Going Home…</p>
		{:else}
			<p role="alert" class="text-sm">
				<span class="font-medium">This screen couldn't open.</span>
				{page.error?.message}
			</p>
			<a
				href={resolve('/')}
				class="inline-flex h-12 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
				>Go Home</a
			>
		{/if}
	</div>
</Screen>
