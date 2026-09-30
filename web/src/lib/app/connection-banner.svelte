<script lang="ts">
	import WifiOff from '@lucide/svelte/icons/wifi-off';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
</script>

{#if !pwa.online}
	<p
		role="status"
		class="flex shrink-0 items-center gap-2 border-b bg-waiting-soft px-4 py-2 text-sm text-foreground"
	>
		<WifiOff class="size-4 shrink-0 text-waiting" aria-hidden="true" />
		You're offline. The app reconnects on its own when the network is back.
	</p>
{/if}
