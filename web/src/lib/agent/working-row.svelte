<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import CircleStop from '@lucide/svelte/icons/circle-stop';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { cn } from '$lib/utils';
	import type { Turn, TurnStep } from './types';

	let {
		turn,
		open = false,
		openStep
	}: { turn: Turn; open?: boolean; openStep?: string } = $props();

	const count = $derived(turn.steps.length);
	const failed = $derived(turn.steps.filter((s) => s.state === 'failed').length);
	const current = $derived(turn.steps.findLast((s) => s.state === 'running'));
	const busy = $derived(
		turn.state === 'working' || turn.state === 'thinking' || turn.state === 'stopping'
	);
	const steps = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;
	const headline = $derived.by(() => {
		if (turn.label) return turn.label;
		switch (turn.state) {
			case 'working':
				return current?.label ?? 'Working…';
			case 'thinking':
				return 'Thinking…';
			case 'stopping':
				return 'Stopping…';
			case 'stopped':
				return 'Stopped by you';
			case 'done':
				return `Used ${count} ${count === 1 ? 'tool' : 'tools'}`;
		}
	});
	const meta = $derived(
		[turn.state === 'done' ? turn.elapsed : count ? steps(count) : undefined]
			.filter(Boolean)
			.join(' · ')
	);
</script>

{#snippet stepIcon(step: TurnStep)}
	{#if step.state === 'running'}
		<LoaderCircle
			class="size-4 shrink-0 animate-spin text-running motion-reduce:animate-none"
			aria-label="Running"
		/>
	{:else if step.state === 'failed'}
		<CircleX class="size-4 shrink-0 text-failed" aria-label="Failed" />
	{:else}
		<CircleCheck class="size-4 shrink-0 text-muted-foreground" aria-label="Done" />
	{/if}
{/snippet}

<details {open} class="group/turn rounded-xl border bg-card text-sm">
	<summary
		class="flex min-h-12 cursor-pointer list-none items-center gap-2.5 px-3 py-2 [&::-webkit-details-marker]:hidden"
	>
		{#if busy}
			<LoaderCircle
				class="size-4 shrink-0 animate-spin text-running motion-reduce:animate-none"
				aria-hidden="true"
			/>
		{:else if turn.state === 'stopped'}
			<CircleStop class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{:else}
			<CircleCheck class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
			<span class="font-medium [overflow-wrap:anywhere]">{headline}</span>
			{#if meta}<span class="text-muted-foreground">· {meta}</span>{/if}
			{#if failed}
				<span class="inline-flex items-center gap-1 font-medium text-failed">
					· <CircleX class="size-3.5" aria-hidden="true" />{steps(failed)} failed
				</span>
			{/if}
		</span>
		{#if count}
			<ChevronDown
				class="size-4 shrink-0 text-muted-foreground transition-transform group-open/turn:rotate-180 motion-reduce:transition-none"
				aria-hidden="true"
			/>
		{/if}
	</summary>
	{#if count}
		<ol class="flex flex-col border-t py-1">
			{#each turn.steps as step, i (`${i}:${step.id}`)}
				<li>
					<details open={openStep === step.id} class="group/step">
						<summary
							class="flex min-h-12 cursor-pointer list-none items-center gap-2.5 px-3 py-1.5 [&::-webkit-details-marker]:hidden"
						>
							{@render stepIcon(step)}
							<span class="flex min-w-0 flex-1 flex-col">
								<span class={cn(step.state === 'failed' && 'text-failed')}>{step.label}</span>
								<code class="font-mono text-xs text-muted-foreground">{step.tool}</code>
							</span>
						</summary>
						<dl class="mx-3 mb-2 flex flex-col gap-2 rounded-lg bg-muted p-2.5 text-xs">
							<div class="flex flex-col gap-1">
								<dt class="text-muted-foreground">Input</dt>
								<dd>
									<pre
										class="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre">{step.input}</pre>
								</dd>
							</div>
							{#if step.output}
								<div class="flex flex-col gap-1">
									<dt class="text-muted-foreground">Output</dt>
									<dd>
										<pre
											class="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">{step.output}</pre>
									</dd>
								</div>
							{/if}
						</dl>
					</details>
				</li>
			{/each}
		</ol>
	{/if}
</details>
