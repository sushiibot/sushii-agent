<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Archive from '@lucide/svelte/icons/archive';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import Copy from '@lucide/svelte/icons/copy';
	import Split from '@lucide/svelte/icons/split';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { cn } from '$lib/utils';
	import AppShell from '../app-shell.svelte';
	import ApprovalCard from '../approval-card.svelte';
	import ApprovalActions from '../approval-actions.svelte';
	import Conversation from '../conversation.svelte';
	import type { ChatMessage, EmailDraft, MemoryWrite, Session, ThreadClose } from '../types';

	type Stage = 'drafting' | 'approval' | 'editing' | 'edited' | 'sent' | 'denied';
	type Sheet = 'memory' | 'close' | 'actions' | 'aside';
	let {
		session,
		messages,
		approval,
		typing = '',
		sheet: initialSheet,
		pressed,
		writes = [],
		closing,
		aside,
		archived,
		waiting = 2
	}: {
		session: Session;
		messages: ChatMessage[];
		approval?: { draft: EmailDraft; stage: Stage; messageId?: string; runHref?: string };
		typing?: string;
		sheet?: Sheet;
		pressed?: string;
		writes?: MemoryWrite[];
		closing?: ThreadClose;
		aside?: { question: string; answer: string };
		archived?: string;
		waiting?: number;
	} = $props();
	const uid = $props.id();

	// svelte-ignore state_referenced_locally
	let sheet = $state<Sheet | undefined>(initialSheet);
	const thread = $derived(session.kind === 'thread');
	const mode = $derived(
		approval?.stage === 'editing' || approval?.stage === 'sent' || approval?.stage === 'denied'
			? approval.stage
			: 'pending'
	);
	const blocking = $derived(
		approval && approval.stage !== 'drafting' && (mode === 'pending' || mode === 'editing')
	);
	const pressedText = $derived(
		messages
			.find((m) => m.id === pressed)
			?.parts.find((p) => p.type === 'text')
			?.text.slice(0, 90)
	);
	const sheetLabels: Record<Sheet, string> = {
		memory: 'Memory shared with Main',
		close: 'Close thread',
		actions: 'Message actions',
		aside: 'Side question'
	};
</script>

{#snippet composer(compact: boolean, placeholder?: string)}
	<form class={cn('px-3', compact ? 'pt-1 pb-2' : 'py-2.5')} onsubmit={(e) => e.preventDefault()}>
		<label for="{uid}-composer" class="sr-only">Message</label>
		<div
			class={cn(
				'flex items-end gap-2 rounded-3xl border bg-card p-1 pl-2 focus-within:ring-2 focus-within:ring-ring/40',
				'kb:ring-2 kb:ring-ring/40'
			)}
		>
			<Textarea
				id="{uid}-composer"
				rows={1}
				value={typing}
				placeholder={placeholder ??
					(compact
						? 'Reply while this waits'
						: thread
							? `Message in ${session.title}`
							: 'Message your agent')}
				class={cn(
					'resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0 dark:bg-transparent',
					compact ? 'min-h-8 py-1' : 'min-h-9'
				)}
			/>
			<Button
				size={compact ? 'icon' : 'icon-lg'}
				type="submit"
				aria-label="Send message"
				class="rounded-full"
				disabled={!typing}><ArrowUp /></Button
			>
		</div>
	</form>
{/snippet}

{#snippet writeList(items: MemoryWrite[])}
	<ul class="flex flex-col divide-y rounded-lg border">
		{#each items as w (w.id)}
			<li>
				<a
					href="/memory/{w.id}"
					class="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50"
				>
					<span class="flex min-w-0 flex-col gap-0.5">
						<span>{w.summary}</span>
						<span class="truncate font-mono text-xs text-muted-foreground">{w.file} · {w.when}</span
						>
					</span>
					<ChevronRight class="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet sheetBody()}
	{#if sheet === 'memory'}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">Shares memory with Main</h2>
				<p class="text-sm text-muted-foreground">
					This thread has its own conversation but reads and writes the same memory as Main. Its
					writes are tagged, so you can check or revert them.
				</p>
			</div>
			<h3 class="text-sm font-medium">{writes.length} writes from this thread</h3>
			{@render writeList(writes)}
			<Button variant="outline" size="lg" href="/memory">All memory changes</Button>
		</div>
	{:else if sheet === 'close' && closing}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">Close {session.title}?</h2>
				<p class="text-sm text-muted-foreground">
					The thread is archived and stays searchable. You can reopen it later.
				</p>
			</div>
			<section class="flex flex-col gap-2">
				<h3 class="text-sm font-medium">Kept in memory</h3>
				{@render writeList(closing.writes)}
			</section>
			<section class="flex flex-col gap-2">
				<h3 class="text-sm font-medium">Report to Main</h3>
				<p class="flex items-start gap-2.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
					<Archive class="mt-0.5 size-4 shrink-0 text-review" aria-hidden="true" />
					<span><span class="font-medium">{closing.report.title}:</span> {closing.report.line}</span
					>
				</p>
			</section>
			<div class="flex flex-col gap-2 pt-1">
				<Button size="lg" class="h-11"><Archive />Close thread</Button>
				<Button size="lg" variant="ghost" class="h-11">Keep open</Button>
			</div>
		</div>
	{:else if sheet === 'actions'}
		<div class="flex flex-col gap-3 px-3 pt-1 pb-3">
			{#if pressedText}
				<p class="mx-2 line-clamp-2 border-l-2 pl-3 text-sm text-muted-foreground">
					{pressedText}…
				</p>
			{/if}
			<ul class="flex flex-col">
				{#each [{ icon: Copy, label: 'Copy text', note: '' }, { icon: Split, label: 'Branch into a thread', note: 'Starts a thread from this message, with what came before it as the brief' }, { icon: MessageCircleQuestion, label: 'Ask on the side', note: 'A quick question that stays out of this chat' }] as a (a.label)}
					<li>
						<button
							type="button"
							class="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted"
						>
							<a.icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="flex flex-col gap-0.5">
								<span class="text-[15px] font-medium">{a.label}</span>
								{#if a.note}<span class="text-sm text-muted-foreground">{a.note}</span>{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{:else if sheet === 'aside' && aside}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-2">
			<div class="flex items-center justify-between gap-3">
				<h2 class="text-lg font-semibold">On the side</h2>
				<Button variant="ghost">Done</Button>
			</div>
			<p class="-mt-3 text-sm text-muted-foreground">Not added to {session.title}'s history.</p>
			<p
				class="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[15px] text-primary-foreground"
			>
				{aside.question}
			</p>
			<p class="text-[15px] leading-relaxed">{aside.answer}</p>
		</div>
		{@render composer(false, 'Ask another side question')}
	{/if}
{/snippet}

{#snippet footer()}
	{#if archived}
		<div class="flex items-center gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
			<Archive class="size-4 shrink-0" aria-hidden="true" />
			<span>Archived {archived}. Read only.</span>
			<Button variant="outline" class="ml-auto"><RotateCcw />Reopen</Button>
		</div>
	{:else if blocking}
		<div role="group" aria-label="Approve send_email" class="flex flex-col gap-2 border-t pt-2.5">
			<p class="px-3 text-xs text-muted-foreground">
				{mode === 'editing'
					? 'Editing the body. The agent is paused.'
					: 'The agent is paused until you decide.'}
			</p>
			<div class="px-3"><ApprovalActions editing={mode === 'editing'} /></div>
			{#if mode === 'pending'}{@render composer(true)}{:else}<span class="h-2.5"></span>{/if}
		</div>
	{:else}
		<div class="border-t">{@render composer(false)}</div>
	{/if}
{/snippet}

{#snippet subtitle()}
	{#if thread}
		<button
			type="button"
			onclick={() => (sheet = 'memory')}
			class="max-w-full self-start truncate text-left text-xs text-muted-foreground hover:text-foreground"
		>
			<BookMarked class="inline size-3 align-[-1px]" aria-hidden="true" /> Shares memory with Main
			{#if writes.length}<span class="text-brand">· {writes.length} writes</span>{/if}
		</button>
	{:else}
		<span class="text-xs text-muted-foreground">Threads report back here</span>
	{/if}
{/snippet}

{#snippet actions()}
	{#if thread && !archived}
		<Button variant="ghost" onclick={() => (sheet = 'close')}
			><Archive /><span class="@max-sm:sr-only">Close</span></Button
		>
	{/if}
{/snippet}

<AppShell
	active="chats"
	title={session.title}
	{subtitle}
	back={{ href: '/chats', label: 'Chats' }}
	{waiting}
	{actions}
	{footer}
	sheet={sheet ? sheetBody : undefined}
	sheetLabel={sheet ? sheetLabels[sheet] : undefined}
	stickToBottom
>
	<div class="mx-auto max-w-2xl">
		<Conversation {messages} {pressed} after={approval ? approvalTurn : undefined} />
	</div>
</AppShell>

{#snippet approvalTurn()}
	{#if approval}
		{#if approval.stage === 'drafting'}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
				Drafting a reply to Dana…
			</p>
		{:else}
			<p class="text-[15px] leading-relaxed">
				{approval.stage === 'denied'
					? "OK, I won't send it. Tell me what to change, or I'll drop it."
					: approval.stage === 'sent'
						? 'Sent. I checked the Sent folder and the message is there.'
						: "Here's the reply. Nothing goes out until you approve it."}
			</p>
			<ApprovalCard
				draft={approval.draft}
				{mode}
				tainted
				messageId={approval.messageId}
				runHref={approval.runHref}
				actions={false}
			/>
		{/if}
	{/if}
{/snippet}
