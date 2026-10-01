<script lang="ts" module>
	export interface DiffLine {
		kind: 'add' | 'del' | 'ctx';
		text: string;
	}
</script>

<script lang="ts">
	import { cn } from '$lib/utils';

	let {
		lines,
		file,
		class: className
	}: { lines: DiffLine[]; file?: string; class?: string } = $props();
	const added = $derived(lines.filter((l) => l.kind === 'add').length);
	const removed = $derived(lines.filter((l) => l.kind === 'del').length);
	const mark = { add: '+', del: '−', ctx: ' ' };
</script>

<!-- A gutter mark and screen-reader words carry each change, so colour is never the only signal. -->
<figure class={cn('overflow-hidden rounded-xl border bg-card text-code', className)}>
	{#if file}
		<figcaption
			class="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2 font-mono text-meta"
		>
			<span class="min-w-0 [overflow-wrap:anywhere]">{file}</span>
			<span class="shrink-0 tabular-nums">
				<span class="text-review">+{added}</span>
				<span class="text-failed">−{removed}</span>
				<span class="sr-only">: {added} lines added, {removed} removed</span>
			</span>
		</figcaption>
	{/if}
	<div class="font-mono leading-relaxed">
		{#each lines as line, i (i)}
			<div
				class={cn(
					'grid grid-cols-[1.5rem_1fr]',
					line.kind === 'add' && 'bg-add',
					line.kind === 'del' && 'bg-del'
				)}
			>
				<span class="text-center text-muted-foreground select-none" aria-hidden="true"
					>{mark[line.kind]}</span
				>
				<span class="pr-3 [overflow-wrap:anywhere] whitespace-pre-wrap"
					>{#if line.kind !== 'ctx'}<span class="sr-only"
							>{line.kind === 'add' ? 'Added: ' : 'Removed: '}</span
						>{/if}{line.text || ' '}</span
				>
			</div>
		{/each}
	</div>
</figure>
