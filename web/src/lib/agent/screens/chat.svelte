<script lang="ts">
	import Wrench from '@lucide/svelte/icons/wrench';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import AppShell from '../app-shell.svelte';
	import ApprovalCard from '../approval-card.svelte';
	import ApprovalActions from '../approval-actions.svelte';
	import type { ChatMessage, EmailDraft } from '../types';

	type Stage = 'drafting' | 'approval' | 'editing' | 'edited' | 'sent' | 'denied';
	let {
		messages,
		draft,
		stage,
		messageId,
		runHref
	}: {
		messages: ChatMessage[];
		draft: EmailDraft;
		stage: Stage;
		messageId?: string;
		runHref?: string;
	} = $props();
	const uid = $props.id();

	const mode = $derived(
		stage === 'editing'
			? 'editing'
			: stage === 'sent'
				? 'sent'
				: stage === 'denied'
					? 'denied'
					: 'pending'
	);
</script>

<AppShell active="chat" title="Chat" waiting={stage === 'sent' || stage === 'denied' ? 1 : 2}>
	<div class="mx-auto flex min-h-full max-w-2xl flex-col">
		<ol class="flex flex-1 flex-col gap-4 px-4 py-4">
			{#each messages as message (message.id)}
				<li class={message.role === 'user' ? 'flex justify-end' : 'flex flex-col gap-2'}>
					{#each message.parts as part, i (i)}
						{#if part.type === 'text'}
							<p
								class={message.role === 'user'
									? 'max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground'
									: 'text-sm leading-relaxed'}
							>
								{part.text}
							</p>
						{:else}
							<details class="group rounded-lg border bg-card text-sm">
								<summary
									class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground"
								>
									<Wrench class="size-3.5" aria-hidden="true" />
									<code class="font-mono text-xs text-foreground">{part.type.slice(5)}</code>
									<span class="truncate">{part.output?.found ?? ''}</span>
								</summary>
								<pre
									class="border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{JSON.stringify(
										part.input,
										null,
										2
									)}</pre>
							</details>
						{/if}
					{/each}
				</li>
			{/each}

			<li class="flex flex-col gap-2">
				{#if stage === 'drafting'}
					<p class="flex items-center gap-2 text-sm text-muted-foreground">
						<LoaderCircle
							class="size-4 animate-spin motion-reduce:animate-none"
							aria-hidden="true"
						/>
						Drafting a reply to Dana…
					</p>
				{:else}
					<p class="text-sm leading-relaxed">
						{stage === 'denied'
							? "OK, I won't send it. Tell me what to change, or I'll drop it."
							: stage === 'sent'
								? 'Sent. I checked the Sent folder and the message is there.'
								: "Here's the reply. Nothing goes out until you approve it."}
					</p>
					<ApprovalCard {draft} {mode} tainted {messageId} {runHref} actions={false} />
				{/if}
			</li>
		</ol>

		{#if mode === 'pending' || mode === 'editing'}
			<div
				role="group"
				aria-label="Approve send_email"
				class="sticky bottom-0 flex flex-col gap-2 border-t bg-background/95 px-3 py-2.5 backdrop-blur-sm"
			>
				<p class="text-xs text-muted-foreground">
					{mode === 'editing'
						? 'Editing the draft. The agent is paused.'
						: 'The agent is paused until you decide.'}
				</p>
				<ApprovalActions editing={mode === 'editing'} />
			</div>
		{:else}
			<form
				class="sticky bottom-0 border-t bg-background/95 px-3 py-2.5 backdrop-blur-sm"
				onsubmit={(e) => e.preventDefault()}
			>
				<label for="{uid}-composer" class="sr-only">Message</label>
				<div
					class="flex items-end gap-2 rounded-xl border bg-card p-1.5 focus-within:ring-2 focus-within:ring-ring/40"
				>
					<Textarea
						id="{uid}-composer"
						rows={1}
						placeholder="Message your agent"
						class="min-h-9 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
					/>
					<Button size="icon-lg" type="submit" aria-label="Send message"><ArrowUp /></Button>
				</div>
			</form>
		{/if}
	</div>
</AppShell>
