<script lang="ts">
	import type { MdBlock } from './types';

	let { blocks }: { blocks: MdBlock[] } = $props();
	const safe = (href: string) => /^(https?:|mailto:)/i.test(href);
</script>

<div class="flex flex-col gap-2 text-[15px] leading-relaxed">
	{#each blocks as block, i (i)}
		{#if block.kind === 'heading'}
			<h3 class="text-base font-semibold">{block.text}</h3>
		{:else}
			<p>
				{#each block.inlines as inline, j (j)}
					{#if inline.kind === 'strong'}<strong class="font-semibold">{inline.text}</strong
						>{:else if inline.kind === 'code'}<code
							class="rounded bg-muted px-1 font-mono text-[13px]">{inline.text}</code
						>{:else if inline.kind === 'link' && safe(inline.href)}<a
							href={inline.href}
							target="_blank"
							rel="noopener noreferrer"
							class="[overflow-wrap:anywhere] text-brand underline">{inline.text}</a
						>{:else}{inline.text}{/if}
				{/each}
			</p>
		{/if}
	{/each}
</div>
