<script lang="ts">
	import Info from '@lucide/svelte/icons/info';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import { Button } from '$lib/ui/button';
	import { Input } from '$lib/ui/input';
	import { cn } from '$lib/utils';
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
</script>

<section
	aria-labelledby="{uid}-q"
	data-surface="ask"
	class={cn(
		'flex flex-col gap-3 text-[15px] leading-relaxed',
		focused && '-mx-2 rounded-xl px-2 py-2 ring-2 ring-brand/60'
	)}
>
	{#if ask.state === 'history'}
		<p id="{uid}-q">
			<span class="text-muted-foreground">The agent asked:</span>
			{ask.question}
		</p>
		{#if ask.answer}
			<p><span class="text-muted-foreground">You answered:</span> {ask.answer}</p>
		{/if}
	{:else}
		<p id="{uid}-q">
			<span class="font-semibold">The agent asks:</span>
			{ask.question}
		</p>
		{#if live}
			<div role="group" aria-label="Answers" class="flex flex-wrap gap-2">
				{#each ask.choices as choice, index (index)}
					{@const picked = ask.state === 'answering' && ask.answer === choice}
					<Button
						variant="outline"
						class={cn('rounded-full px-4 font-medium', picked && 'border-foreground')}
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
				Answering a question doesn't give the agent permission to act.
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
