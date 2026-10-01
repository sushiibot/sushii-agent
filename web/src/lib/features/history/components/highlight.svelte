<script lang="ts">
	// Matches are cut out as text nodes; the snippet never goes through markup.
	import { highlightParts } from '../highlight';
	import type { Range } from '../types';

	let { text, ranges }: { text: string; ranges: readonly Range[] } = $props();
	const parts = $derived(highlightParts(text, ranges));
</script>

{#each parts as part, i (i)}{#if part.match}<mark
			class="rounded-sm bg-brand/20 px-0.5 text-foreground">{part.text}</mark
		>{:else}{part.text}{/if}{/each}
