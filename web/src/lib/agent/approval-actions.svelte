<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Pencil from '@lucide/svelte/icons/pencil';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';

	let { editing = false }: { editing?: boolean } = $props();
</script>

<div class="flex flex-wrap gap-2">
	{#if editing}
		<Button size="lg"><Check />Save and review</Button>
		<Button size="lg" variant="ghost">Cancel edit</Button>
	{:else}
		<Button size="lg"><Check />Approve and send</Button>
		<Button size="lg" variant="outline"><Pencil />Edit</Button>
		<Button size="lg" variant="ghost" class="text-failed hover:text-failed"><X />Deny</Button>
	{/if}
</div>
