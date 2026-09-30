<script lang="ts">
	import { pwa } from './pwa.svelte';
</script>

<span class="flex-1">Update ready</span>
<button
	type="button"
	onclick={() => pwa.applyUpdate()}
	class="-my-2 -mr-2 h-12 shrink-0 rounded-lg px-3 font-semibold text-background underline-offset-4 hover:underline"
>
	Reload
</button>
