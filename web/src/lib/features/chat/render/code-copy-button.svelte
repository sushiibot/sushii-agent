<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';

	// The one control allowed inside agent markdown: it only copies the block's own text.
	let { text, disabled = false }: { text: string; disabled?: boolean } = $props();

	let copied = $state(false);
	let announcement = $state('');
	let reset: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		clearTimeout(reset);
		try {
			if (!navigator.clipboard) throw new Error('no clipboard');
			await navigator.clipboard.writeText(text);
			copied = true;
			announcement = 'Copied';
		} catch {
			copied = false;
			announcement = "Couldn't copy";
		}
		reset = setTimeout(() => {
			copied = false;
			announcement = '';
		}, 2000);
	}

	$effect(() => () => clearTimeout(reset));
</script>

<button
	type="button"
	aria-label="Copy code"
	{disabled}
	onclick={copy}
	class="absolute top-0 right-0 grid size-12 place-items-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-40"
>
	{#if copied}<Check class="size-4" aria-hidden="true" />{:else}<Copy
			class="size-4"
			aria-hidden="true"
		/>{/if}
</button>
<span class="sr-only" aria-live="polite">{announcement}</span>
