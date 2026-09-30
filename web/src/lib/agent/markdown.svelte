<script lang="ts">
	import type { MdBlock } from './types';
	import CodeCopyButton from './code-copy-button.svelte';
	import {
		fromLegacyBlocks,
		legacyPlainText,
		parseMarkdown,
		type MdBlockNode,
		type MdInlineNode
	} from './render/markdown';

	// Agent text is untrusted: no controls besides Copy and no security-surface styling here, so
	// nothing in a reply can pass for a decision card. scripts/check-no-raw-html.ts enforces it.
	let {
		text,
		blocks,
		files = [],
		streaming = false
	}: {
		/** Raw markdown from the agent. Takes precedence over `blocks`. */
		text?: string;
		/** Pre-parsed prototype blocks. */
		blocks?: MdBlock[];
		/** Files the bot attached to this same message; inline ones may appear as `![](/f/<id>)`. */
		files?: readonly { id: string; inline: boolean }[];
		/** While true `text` shows unparsed, so a stream of deltas never re-runs the parser. */
		streaming?: boolean;
	} = $props();

	// A string, so a new but equal `files` array does not trigger a re-parse.
	const imageKey = $derived(
		files
			.filter((f) => f.inline)
			.map((f) => f.id)
			.join(' ')
	);

	const tree = $derived.by((): MdBlockNode[] => {
		if (streaming && text !== undefined) return [{ kind: 'plain', text }];
		const ctx = {
			origin: typeof location === 'undefined' ? undefined : location.origin,
			imageIds: imageKey ? imageKey.split(' ') : []
		};
		if (text !== undefined) return parseMarkdown(text, ctx);
		return fromLegacyBlocks(blocks ?? [], ctx);
	});

	const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;
</script>

{#snippet inlines(nodes: MdInlineNode[])}
	{#each nodes as node, i (i)}
		{#if node.kind === 'text'}{node.text}{:else if node.kind === 'strong'}<strong
				class="font-semibold">{@render inlines(node.children)}</strong
			>{:else if node.kind === 'em'}<em>{@render inlines(node.children)}</em
			>{:else if node.kind === 'del'}<del>{@render inlines(node.children)}</del
			>{:else if node.kind === 'code'}<code
				class="rounded bg-muted px-1 font-mono text-[0.8125rem] [overflow-wrap:anywhere]"
				>{node.text}</code
			>{:else if node.kind === 'link'}<a
				href={node.href}
				target="_blank"
				rel="noopener noreferrer"
				class="[overflow-wrap:anywhere] text-brand underline">{@render inlines(node.children)}</a
			>{:else if node.kind === 'image'}<img
				src={node.src}
				alt={node.alt}
				loading="lazy"
				class="inline-block max-h-60 max-w-full rounded-lg border align-middle"
			/>{:else if node.kind === 'break'}<br />{/if}
	{/each}
{/snippet}

{#snippet listItems(items: Extract<MdBlockNode, { kind: 'list' }>['items'])}
	{#each items as item, j (j)}
		<li>
			{#if item.checked !== null}<span class="font-mono" aria-hidden="true"
					>{item.checked ? '[x] ' : '[ ] '}</span
				><span class="sr-only">{item.checked ? 'Done: ' : 'Not done: '}</span>{/if}
			<div class="flex flex-col gap-1">{@render blockList(item.children)}</div>
		</li>
	{/each}
{/snippet}

{#snippet blockList(nodes: MdBlockNode[])}
	{#each nodes as node, i (i)}
		{#if node.kind === 'paragraph'}
			<p>{@render inlines(node.children)}</p>
		{:else if node.kind === 'plain'}
			<p class="whitespace-pre-wrap">{node.text}</p>
		{:else if node.kind === 'heading'}
			{#if node.level <= 2}
				<h3 class="text-base font-semibold">{@render inlines(node.children)}</h3>
			{:else if node.level === 3}
				<h4 class="text-base font-semibold">{@render inlines(node.children)}</h4>
			{:else if node.level === 4}
				<h5 class="text-base font-semibold">{@render inlines(node.children)}</h5>
			{:else}
				<h6 class="text-base font-semibold">{@render inlines(node.children)}</h6>
			{/if}
		{:else if node.kind === 'code'}
			<div class="relative">
				<pre
					class="min-h-12 overflow-x-auto rounded-lg bg-muted py-2 pr-12 pl-3 font-mono text-[0.8125rem] leading-relaxed"
					data-lang={node.lang}><code>{node.text}</code></pre>
				<CodeCopyButton text={node.text} />
			</div>
		{:else if node.kind === 'quote'}
			<blockquote class="flex flex-col gap-2 border-l-2 pl-3 text-muted-foreground">
				{@render blockList(node.children)}
			</blockquote>
		{:else if node.kind === 'list'}
			{#if node.ordered}
				<ol start={node.start ?? undefined} class="flex list-decimal flex-col gap-1 pl-5">
					{@render listItems(node.items)}
				</ol>
			{:else}
				<ul class="flex list-disc flex-col gap-1 pl-5">{@render listItems(node.items)}</ul>
			{/if}
		{:else if node.kind === 'table'}
			<div class="max-w-full overflow-x-auto rounded-lg border">
				<table class="w-max min-w-full border-collapse text-sm">
					<thead>
						<tr>
							{#each node.head as cell, j (j)}
								<th
									class={[
										'border-b bg-muted px-2.5 py-1.5 font-semibold',
										alignClass[node.align[j] ?? 'left'],
										j === 0 && 'sticky left-0'
									]}>{@render inlines(cell)}</th
								>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each node.rows as row, r (r)}
							<tr>
								{#each row as cell, j (j)}
									<td
										class={[
											'border-b px-2.5 py-1.5 align-top',
											alignClass[node.align[j] ?? 'left'],
											j === 0 && 'sticky left-0 bg-background'
										]}>{@render inlines(cell)}</td
									>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if node.kind === 'rule'}
			<hr class="border-border" />
		{/if}
	{/each}
{/snippet}

<div class="flex min-w-0 flex-col gap-2 text-[0.9375rem] leading-relaxed [overflow-wrap:anywhere]">
	<!-- One reply that fails to render falls back to its text instead of taking the list down. -->
	<svelte:boundary>
		{@render blockList(tree)}
		{#snippet failed()}
			<p class="whitespace-pre-wrap">{text ?? legacyPlainText(blocks ?? [])}</p>
		{/snippet}
	</svelte:boundary>
</div>
