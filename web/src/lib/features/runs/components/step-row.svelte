<script lang="ts">
	// Every text here is the agent's own record: plain text, or markdown through the safe renderer.
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Info from '@lucide/svelte/icons/info';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import User from '@lucide/svelte/icons/user';
	import { Markdown } from '$lib/features/chat';
	import { clock, duration } from '$lib/ui/format/time';
	import { cn } from '$lib/utils';
	import type { RunStep } from '../types';

	let { step, open = false }: { step: RunStep; open?: boolean } = $props();
	const uid = $props.id();
	// svelte-ignore state_referenced_locally
	let expanded = $state(open);

	const LONG_TEXT = 480;
	const long = $derived(
		(step.type === 'user' || step.type === 'assistant') && step.text.length > LONG_TEXT
	);
	const at = $derived(clock(Date.parse(step.at)));
</script>

{#if step.type === 'tool'}
	{@const Icon = step.ok === null ? CircleDashed : step.ok ? CircleCheck : CircleX}
	<div class="flex flex-col">
		<button
			type="button"
			aria-expanded={expanded}
			aria-controls="{uid}-detail"
			onclick={() => (expanded = !expanded)}
			class="flex min-h-12 w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
		>
			<Icon
				class={cn(
					'mt-0.5 size-4 shrink-0',
					step.ok === false ? 'text-failed' : 'text-muted-foreground'
				)}
				aria-label={step.ok === null ? 'No result' : step.ok ? 'Succeeded' : 'Failed'}
			/>
			<span class="flex min-w-0 flex-1 flex-col gap-0.5">
				<span class="flex items-baseline justify-between gap-3">
					<code class="font-mono text-code font-medium [overflow-wrap:anywhere]">{step.name}</code>
					<span class="shrink-0 text-meta text-muted-foreground tabular-nums">
						{step.durationMs !== undefined ? duration(step.durationMs) : at}
					</span>
				</span>
				<span class="truncate font-mono text-meta text-muted-foreground">{step.args}</span>
			</span>
			<ChevronDown
				class={cn(
					'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
					expanded && 'rotate-180'
				)}
				aria-hidden="true"
			/>
		</button>
		<div id="{uid}-detail" hidden={!expanded} class="ml-8 flex flex-col gap-2 pr-2 pb-2">
			<dl class="flex flex-col gap-2 text-meta">
				<div class="flex flex-col gap-1">
					<dt class="text-muted-foreground">Input</dt>
					<dd
						class="rounded-md bg-muted px-2.5 py-2 font-mono text-code [overflow-wrap:anywhere] whitespace-pre-wrap"
					>
						{step.args}
					</dd>
				</div>
				<div class="flex flex-col gap-1">
					<dt class="text-muted-foreground">
						{step.ok === null ? 'Result' : step.ok ? 'Result' : 'Error'} · {at}
					</dt>
					<dd
						class={cn(
							'rounded-md px-2.5 py-2 font-mono text-code [overflow-wrap:anywhere] whitespace-pre-wrap',
							step.ok === false ? 'bg-failed-soft text-failed' : 'bg-muted'
						)}
					>
						{step.ok === null ? 'No result was recorded for this step.' : step.result}
					</dd>
				</div>
			</dl>
		</div>
	</div>
{:else if step.type === 'note'}
	{@const Icon = step.kind === 'error' || step.kind === 'aborted' ? TriangleAlert : Info}
	<p
		class={cn(
			'flex items-start gap-2.5 px-2 py-2 text-sm',
			step.kind === 'error' || step.kind === 'aborted' ? 'text-failed' : 'text-muted-foreground'
		)}
	>
		<Icon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<span class="[overflow-wrap:anywhere]">{step.text}</span>
	</p>
{:else}
	<div class="flex items-start gap-2.5 px-2 py-2">
		{#if step.type === 'user'}
			<User class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{:else}
			<MessageSquare class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<div class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="text-meta text-muted-foreground">
				{step.type === 'user' ? 'Task' : 'The agent wrote'} · {at}
			</span>
			<div
				id="{uid}-text"
				class={cn(
					'text-sm [overflow-wrap:anywhere]',
					long && !expanded && 'line-clamp-6',
					step.type === 'user' && 'whitespace-pre-wrap'
				)}
			>
				{#if step.type === 'assistant'}<Markdown text={step.text} />{:else}{step.text}{/if}
			</div>
			{#if long}
				<button
					type="button"
					aria-expanded={expanded}
					aria-controls="{uid}-text"
					onclick={() => (expanded = !expanded)}
					class="-ml-2 flex h-12 items-center self-start px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
				>
					{expanded ? 'Show less' : 'Show all'}
				</button>
			{/if}
		</div>
	</div>
{/if}
