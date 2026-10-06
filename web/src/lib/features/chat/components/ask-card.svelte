<script lang="ts">
	import ToolConfirmation from './tool-confirmation.svelte';
	import ToolIcon from './tool-icon.svelte';
	import { toolCategory } from '../tool-activity';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Info from '@lucide/svelte/icons/info';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import { cn } from '$lib/utils';
	import { splitAskQuestion } from '../render/ask-question';
	import type { AskView } from '../types';

	let {
		ask,
		focused = false,
		onanswer
	}: {
		ask: AskView;
		focused?: boolean;
		/** `index` is set for a tapped choice, so the caller can POST `{index, label}`; typed text has none. */
		onanswer?: (answer: string, index?: number) => void;
	} = $props();
	const uid = $props.id();
	let text = $state('');
	const live = $derived(ask.state === 'pending' || ask.state === 'answering');
	const parts = $derived(splitAskQuestion(ask.question));
	const COMMAND_LINES = 6;
	const long = $derived((parts.action?.command.split('\n').length ?? 0) > COMMAND_LINES);
	let full = $state(false);
	const confirmation = $derived(ask.toolConfirmation);
</script>

{#snippet question(lead: string, strong: boolean)}
	<p id="{uid}-q" class="whitespace-pre-wrap">
		<span class={strong ? 'font-semibold' : 'text-muted-foreground'}>{lead}</span>
		{parts.title}
	</p>
	{#if parts.action}
		<div class="flex min-w-0 flex-col gap-1">
			<span class="font-mono text-code text-muted-foreground" aria-hidden="true"
				>{parts.action.tool}</span
			>
			<!-- tabindex: the command scrolls sideways inside itself, so keyboard users need to reach it. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<pre
				id="{uid}-cmd"
				tabindex="0"
				role="group"
				aria-label="{parts.action.tool} command"
				class={cn(
					'overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-code leading-relaxed [overflow-wrap:normal] whitespace-pre',
					long &&
						!full &&
						'max-h-[calc(6lh+1rem)] overflow-y-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]'
				)}>{parts.action.command}</pre>
			{#if long}
				<Button
					variant="ghost"
					class="self-start px-3 text-sm font-medium"
					aria-expanded={full}
					aria-controls="{uid}-cmd"
					onclick={() => (full = !full)}
					>{full ? 'Show less' : 'Show full command'}<ChevronDown
						class={cn('transition-transform motion-reduce:transition-none', full && 'rotate-180')}
						aria-hidden="true"
					/></Button
				>
			{/if}
		</div>
		<p class="whitespace-pre-wrap">
			<span class="text-muted-foreground">Why it's asking:</span>
			{parts.action.why}
		</p>
	{/if}
{/snippet}

{#if confirmation}
	<ToolConfirmation {ask} {confirmation} {onanswer} />
{:else if parts.action && !live}
	<details data-surface="ask" class="group/question min-w-0 text-ui text-muted-foreground">
		<summary
			class="flex min-h-12 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden"
		>
			<ToolIcon kind={toolCategory(parts.action.tool).kind} />
			<span class="min-w-0 flex-1 truncate"
				>{parts.action.tool === 'github_push' ? 'GitHub push' : 'Tool question'}</span
			>
			<span class="text-meta">{ask.answer ? `Answered ${ask.answer}` : 'Question closed'}</span>
			<ChevronDown
				class="size-3.5 shrink-0 transition-transform group-open/question:rotate-180 motion-reduce:transition-none"
				aria-hidden="true"
			/>
		</summary>
		<div class="flex min-w-0 flex-col gap-3 pb-2 text-body">
			{@render question('The agent asked:', false)}
		</div>
	</details>
{:else}
	<section
		aria-labelledby="{uid}-q"
		data-surface="ask"
		class={cn(
			'flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/30 p-3 text-body leading-relaxed [overflow-wrap:anywhere]',
			focused && '-mx-2 rounded-xl px-2 py-2 ring-2 ring-brand/60'
		)}
	>
		{#if ask.state === 'history'}
			{@render question('The agent asked:', false)}
			{#if ask.answer}
				<p class="whitespace-pre-wrap">
					<span class="text-muted-foreground">You answered:</span>
					{ask.answer}
				</p>
			{/if}
		{:else}
			{@render question('The agent asks:', true)}
			{#if live}
				<div role="group" aria-label="Answers" class="flex min-w-0 flex-wrap gap-2">
					{#each ask.choices as choice, index (index)}
						{@const picked = ask.state === 'answering' && ask.answer === choice}
						<Button
							variant="outline"
							class={cn(
								'h-auto min-h-12 max-w-full rounded-full px-4 py-2 font-medium whitespace-normal',
								picked && 'border-foreground'
							)}
							disabled={ask.state === 'answering'}
							onclick={() => onanswer?.(choice, index)}
						>
							{#if picked}<LoaderCircle
									class="animate-spin motion-reduce:animate-none"
									aria-hidden="true"
								/>{/if}{choice}
						</Button>
					{/each}
				</div>
				{#if ask.state === 'answering'}
					<p role="status" class="text-sm text-muted-foreground">Sending your answer…</p>
				{:else}
					<form
						class="flex gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							if (text.trim()) onanswer?.(text.trim());
						}}
					>
						<label for="{uid}-a" class="sr-only">Your own answer</label>
						<Input
							id="{uid}-a"
							bind:value={text}
							placeholder="Or type an answer"
							class="h-12 min-w-0 flex-1 text-base"
						/>
						<Button type="submit" variant="outline" class="px-4" disabled={!text.trim()}
							><SendHorizontal /><span class="sr-only">Send answer</span></Button
						>
					</form>
				{/if}
				<p class="flex items-start gap-1.5 text-xs text-muted-foreground">
					<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
					{#if parts.action}
						Yes lets this one command run.
					{:else}
						Answering a question doesn't give the agent permission to act.
					{/if}
				</p>
			{:else}
				<p class="text-sm">
					<span class="text-muted-foreground"
						>{ask.state === 'elsewhere' ? 'Answered on another device:' : 'You answered:'}</span
					>
					<span class="font-medium">{ask.answer}</span>
				</p>
			{/if}
		{/if}
	</section>
{/if}
