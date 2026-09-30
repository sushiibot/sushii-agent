<script lang="ts">
	import Mail from '@lucide/svelte/icons/mail';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Switch } from '$lib/components/ui/switch';
	import { cn } from '$lib/utils';
	import ApprovalActions from './approval-actions.svelte';
	import DiffView from './diff-view.svelte';
	import StatePill from './state-pill.svelte';
	import type { EmailDraft } from './types';

	type Mode = 'pending' | 'editing' | 'sent' | 'denied';
	let {
		draft,
		mode = 'pending',
		tainted = false,
		messageId,
		runHref,
		actions = true
	}: {
		draft: EmailDraft;
		mode?: Mode;
		tainted?: boolean;
		messageId?: string;
		runHref?: string;
		actions?: boolean;
	} = $props();
	const uid = $props.id();

	type Tab = 'preview' | 'changes' | 'raw';
	// svelte-ignore state_referenced_locally
	let tab = $state<Tab>(draft.changes ? 'changes' : 'preview');
	// svelte-ignore state_referenced_locally
	let body = $state(draft.body);
	let alwaysAllow = $state(false);
	const tabs = $derived([
		['preview', 'Preview'],
		...(draft.changes ? [['changes', 'Your edits']] : []),
		['raw', 'Exact input']
	] as [Tab, string][]);
</script>

<section
	aria-label="Approval: send email"
	class={cn(
		'overflow-hidden rounded-xl border bg-card shadow-[0_6px_20px_-12px_rgb(0_0_0/0.35)]',
		mode === 'pending' && 'border-waiting/50'
	)}
>
	<header class="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
		<Mail class="size-4 text-muted-foreground" aria-hidden="true" />
		<span class="text-sm font-semibold">Send email</span>
		{#if mode === 'pending' || mode === 'editing'}
			<StatePill of="waiting" label="Needs approval" />
		{:else if mode === 'sent'}
			<StatePill of="sent" />
		{:else}
			<StatePill of="failed" label="Denied" />
		{/if}
		<code class="ml-auto font-mono text-xs text-muted-foreground">send_email</code>
	</header>

	{#if mode === 'sent'}
		<dl class="grid gap-2 px-3 py-3 text-sm">
			<div class="flex flex-wrap justify-between gap-x-3">
				<dt class="text-muted-foreground">To</dt>
				<dd class="font-medium">{draft.to}</dd>
			</div>
			<div class="flex flex-col gap-0.5">
				<dt class="text-muted-foreground">Message-ID</dt>
				<dd class="font-mono text-[13px] break-all">{messageId}</dd>
			</div>
			<div class="flex items-center gap-1.5 text-review">
				<ShieldCheck class="size-4" aria-hidden="true" />
				<dt class="sr-only">Readback</dt>
				<dd>Found in Sent after sending. Verified.</dd>
			</div>
		</dl>
		{#if runHref}
			<footer class="border-t px-3 py-2">
				<Button variant="link" class="h-auto px-0" href={runHref}>View run<ArrowUpRight /></Button>
			</footer>
		{/if}
	{:else if mode === 'denied'}
		<p class="px-3 py-3 text-sm text-muted-foreground">
			Nothing was sent. The draft stays in the run file if you want it later.
		</p>
	{:else}
		{#if mode === 'pending'}
			<div role="tablist" aria-label="Draft view" class="flex gap-1 border-b px-2 pt-1.5">
				{#each tabs as [id, label] (id)}
					<button
						type="button"
						role="tab"
						aria-selected={tab === id}
						onclick={() => (tab = id)}
						class={cn(
							'-mb-px border-b-2 border-transparent px-2 pb-1.5 text-sm text-muted-foreground',
							tab === id && 'border-foreground font-medium text-foreground'
						)}>{label}</button
					>
				{/each}
			</div>
		{/if}

		<div class="px-3 py-3 text-sm">
			{#if mode === 'editing'}
				<label for="{uid}-draft-body" class="mb-1.5 block text-xs text-muted-foreground">
					Edit the body. Recipients and subject stay fixed.
				</label>
				<Textarea id="{uid}-draft-body" bind:value={body} rows={9} class="text-sm" />
			{:else if tab === 'preview'}
				<dl class="mb-3 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1">
					<dt class="text-muted-foreground">To</dt>
					<dd class="font-medium break-words">{draft.to}</dd>
					<dt class="text-muted-foreground">Subject</dt>
					<dd class="break-words">{draft.subject}</dd>
				</dl>
				<p class="leading-relaxed whitespace-pre-wrap">{draft.body}</p>
				<blockquote class="mt-3 border-l-2 pl-3 text-xs text-muted-foreground">
					<span class="font-medium">{draft.inReplyTo.from} wrote:</span>
					{draft.inReplyTo.excerpt}
				</blockquote>
			{:else if tab === 'changes' && draft.changes}
				<DiffView lines={draft.changes} file="body" />
			{:else}
				<pre
					class="overflow-x-auto rounded-md bg-muted p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">{JSON.stringify(
						{ from: draft.from, to: draft.to, subject: draft.subject, body: draft.body },
						null,
						2
					)}</pre>
			{/if}
		</div>

		{#if mode === 'pending'}
			<label class="flex items-center justify-between gap-3 border-t px-3 py-2.5 text-sm">
				<span class="flex flex-col gap-0.5">
					<span>Always allow for this recipient</span>
					<span class="text-xs text-muted-foreground">
						Later emails to {draft.to.split(' <')[0]} send without asking{tainted
							? ', unless the run read outside content like this one'
							: ''}.
					</span>
				</span>
				<Switch bind:checked={alwaysAllow} />
			</label>
		{/if}

		{#if tainted}
			<p class="flex items-start gap-2 border-t bg-taint-soft/60 px-3 py-2 text-xs text-taint">
				This run read external email, so sending always asks first.
			</p>
		{/if}

		{#if actions}
			<footer class="border-t px-3 py-2.5">
				<ApprovalActions editing={mode === 'editing'} />
			</footer>
		{/if}
	{/if}
</section>
