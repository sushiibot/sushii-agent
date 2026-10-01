<script lang="ts">
	import type { MdBlock } from '../types';
	import CodeCopyButton from './code-copy-button.svelte';
	import {
		fromLegacyBlocks,
		legacyPlainText,
		type MdBlockNode,
		type MdInlineNode
	} from './markdown';
	import { caretHost, MarkdownStream } from './streaming';

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
		/** While true, `text` is still growing: it is re-parsed at most once a frame, only from its
		 *  last unfinished block, and a caret follows the last line. */
		streaming?: boolean;
	} = $props();

	// A string, so a new but equal `files` array does not trigger a re-parse.
	const imageKey = $derived(
		files
			.filter((f) => f.inline)
			.map((f) => f.id)
			.join(' ')
	);

	const stream = new MarkdownStream();
	// The text the stream last rendered. Deltas land in `text` as they arrive; this follows at most
	// once a frame, and slower when parsing is slow.
	let frameText = $state<string | null>(null);
	let frame = 0;
	let measure = 0;
	const FRAME_MS = 1000 / 60;

	function nextFrame() {
		frame = 0;
		// Until the first frame lands, `tree` parses on every delta, so waiting out `nextAt` there would
		// keep it doing so for good.
		if (frameText !== null && performance.now() < stream.nextAt) {
			frame = requestAnimationFrame(nextFrame);
			return;
		}
		const start = performance.now();
		frameText = text ?? '';
		// The next frame starts after the parse, the DOM update and layout, so its delay is their cost.
		cancelAnimationFrame(measure);
		measure = requestAnimationFrame(() =>
			stream.rendered(Math.max(0, performance.now() - start - FRAME_MS))
		);
	}

	$effect(() => {
		if (streaming && text !== undefined && text !== frameText && !frame) {
			frame = requestAnimationFrame(nextFrame);
		}
	});
	$effect(() => () => {
		cancelAnimationFrame(frame);
		cancelAnimationFrame(measure);
	});

	const tree = $derived.by((): MdBlockNode[] => {
		const ctx = {
			origin: typeof location === 'undefined' ? undefined : location.origin,
			imageIds: imageKey ? imageKey.split(' ') : []
		};
		if (text === undefined) return fromLegacyBlocks(blocks ?? [], ctx);
		if (!streaming) return stream.finish(text, ctx, imageKey);
		return stream.update(frameText ?? text, ctx, imageKey);
	});
	const caretAt = $derived(streaming ? caretHost(tree) : null);

	const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;
</script>

<!-- Zero net width, so it never wraps a full line and removing it can't change a block's height. -->
{#snippet caret()}<span
		data-caret
		aria-hidden="true"
		class="-mr-1 ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-[3px] animate-pulse bg-foreground motion-reduce:animate-none"
	></span>{/snippet}

{#snippet inlines(nodes: MdInlineNode[])}
	{#each nodes as node, i (i)}
		{#if node.kind === 'text'}{node.text}{:else if node.kind === 'strong'}<strong
				class="font-semibold">{@render inlines(node.children)}</strong
			>{:else if node.kind === 'em'}<em>{@render inlines(node.children)}</em
			>{:else if node.kind === 'del'}<del>{@render inlines(node.children)}</del
			>{:else if node.kind === 'code'}<code
				class="rounded bg-muted px-1 font-mono text-code [overflow-wrap:anywhere]">{node.text}</code
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
			<p>
				{@render inlines(node.children)}{#if node === caretAt}{@render caret()}{/if}
			</p>
		{:else if node.kind === 'plain'}
			<p class="whitespace-pre-wrap">
				{node.text}{#if node === caretAt}{@render caret()}{/if}
			</p>
		{:else if node.kind === 'heading'}
			{#if node.level <= 2}
				<h3 class="text-base font-semibold">
					{@render inlines(node.children)}{#if node === caretAt}{@render caret()}{/if}
				</h3>
			{:else if node.level === 3}
				<h4 class="text-base font-semibold">
					{@render inlines(node.children)}{#if node === caretAt}{@render caret()}{/if}
				</h4>
			{:else if node.level === 4}
				<h5 class="text-base font-semibold">
					{@render inlines(node.children)}{#if node === caretAt}{@render caret()}{/if}
				</h5>
			{:else}
				<h6 class="text-base font-semibold">
					{@render inlines(node.children)}{#if node === caretAt}{@render caret()}{/if}
				</h6>
			{/if}
		{:else if node.kind === 'code'}
			<div class="relative">
				<pre
					class="min-h-12 overflow-x-auto rounded-lg bg-muted py-2 pr-12 pl-3 font-mono text-code leading-relaxed"
					data-lang={node.lang}><code
						>{node.text}{#if node === caretAt}{@render caret()}{/if}</code
					></pre>
				<!-- Code still streaming would copy a truncated command. -->
				<CodeCopyButton text={node.text} disabled={streaming && node === caretAt} />
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
									]}
									>{@render inlines(cell)}{#if cell === caretAt}{@render caret()}{/if}</th
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
										]}
										>{@render inlines(cell)}{#if cell === caretAt}{@render caret()}{/if}</td
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

<div class="flex min-w-0 flex-col gap-2 text-body leading-relaxed [overflow-wrap:anywhere]">
	<!-- One reply that fails to render falls back to its text instead of taking the list down. -->
	<svelte:boundary>
		{@render blockList(tree)}
		{#if streaming && !tree.length}<p>{@render caret()}</p>{/if}
		{#snippet failed()}
			<p class="whitespace-pre-wrap">{text ?? legacyPlainText(blocks ?? [])}</p>
		{/snippet}
	</svelte:boundary>
</div>
