<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { ChatScreen } from '$lib/features/chat';
	import { BranchSheet } from '$lib/features/threads';

	// Main's chat with the Start-a-thread sheet over it, as the chat route renders the pair.
	let {
		branch,
		...chat
	}: ComponentProps<typeof ChatScreen> & {
		branch: Omit<ComponentProps<typeof BranchSheet>, 'open'>;
	} = $props();
</script>

<ChatScreen {...chat} />
<BranchSheet open {...branch} />
