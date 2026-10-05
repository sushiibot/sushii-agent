<script lang="ts">
	import FoldVertical from '@lucide/svelte/icons/fold-vertical';
	import X from '@lucide/svelte/icons/x';
	import type { ConversationContext } from '$lib/core/realtime/events';
	import { Button } from '$lib/ui/button';

	let {
		context,
		disabled = false,
		compacting = false,
		oncompact,
		onclose
	}: {
		context?: ConversationContext | null;
		disabled?: boolean;
		compacting?: boolean;
		oncompact?: () => void;
		onclose?: () => void;
	} = $props();
	const pct = $derived(context ? Math.round(context.percent) : null);
	const working = $derived(compacting || context?.status === 'compacting');
	const count = (n: number) => Math.round(n).toLocaleString();
</script>

<div
	class="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b bg-background px-5 py-2"
>
	<h2 class="font-semibold">Conversation context</h2>
	<Button variant="ghost" size="icon" class="size-12" aria-label="Close" onclick={onclose}
		><X aria-hidden="true" /></Button
	>
</div>
<div class="space-y-6 px-5 py-5 text-sm">
	<section class="space-y-3" aria-label="Current context">
		<div class="flex items-baseline justify-between gap-3">
			<h3 class="font-medium">Current context</h3>
			<span class="font-medium tabular-nums"
				>{context ? `${context.estimated ? '~' : ''}${pct}% used` : 'Unavailable'}</span
			>
		</div>
		{#if context}
			<div
				role="meter"
				aria-label="Context used"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.min(100, pct ?? 0)}
				class="h-2 overflow-hidden rounded-full bg-muted"
			>
				<div
					class="h-full rounded-full bg-foreground/70"
					style:width="{Math.min(100, context.percent)}%"
				></div>
			</div>
			<p class="tabular-nums">
				{context.estimated ? 'About ' : ''}{count(context.tokens)} of {count(context.window)} tokens
			</p>
			{#if context.model}<p class="text-muted-foreground">Active model: {context.model}</p>{/if}
			{#if working}<p role="status" class="text-muted-foreground">Compacting context…</p>
			{:else if context.estimated}<p class="text-muted-foreground">
					Estimated from the current context. The next model response updates the count.
				</p>
			{:else if context.status === 'updating'}<p class="text-muted-foreground">
					The conversation is running. Usage updates as the agent works.
				</p>{/if}
		{:else}
			<p class="text-muted-foreground">
				The agent hasn't reported this conversation's current context. Older reply counts stay in
				message details.
			</p>
		{/if}
	</section>
	<section class="space-y-3" aria-label="Compaction">
		<h3 class="font-medium">Making room</h3>
		<p class="text-muted-foreground">
			Context is what the agent carries into its next reply. Compaction summarizes older messages
			and keeps recent messages. Your history and shared memory stay available.
		</p>
		{#if context?.compactAt}
			<p class="tabular-nums">
				Automatically compacts at about {count(context.compactAt)} tokens ({Math.round(
					(context.compactAt / context.window) * 100
				)}% of the window).
			</p>
		{:else}<p class="text-muted-foreground">
				The automatic compaction threshold is unavailable.
			</p>{/if}
		<Button
			variant="outline"
			disabled={disabled || working || context?.status === 'updating'}
			onclick={oncompact}><FoldVertical />{working ? 'Compacting…' : 'Compact now'}</Button
		>
	</section>
</div>
