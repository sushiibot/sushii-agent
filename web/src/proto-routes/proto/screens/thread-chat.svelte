<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import Archive from '@lucide/svelte/icons/archive';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import Copy from '@lucide/svelte/icons/copy';
	import Download from '@lucide/svelte/icons/download';
	import Split from '@lucide/svelte/icons/split';
	import MessageCircleQuestion from '@lucide/svelte/icons/message-circle-question';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import ServerOff from '@lucide/svelte/icons/server-off';
	import Square from '@lucide/svelte/icons/square';
	import FoldVertical from '@lucide/svelte/icons/fold-vertical';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { Button } from '$lib/ui/button';
	import AppShell from './app-shell.svelte';
	import ApprovalTray from '$lib/features/chat/components/approval-tray.svelte';
	import Composer from '$lib/features/chat/components/composer.svelte';
	import ConnectionBanner from '$lib/ui/connection-banner.svelte';
	import Conversation from '$lib/features/chat/components/conversation.svelte';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';
	import type {
		ChatMessage,
		FileRef,
		MemoryWrite,
		PendingApproval,
		PhotoDraft
	} from '$lib/features/chat';
	import type { Session, ThreadClose } from './types';

	type Sheet = 'memory' | 'close' | 'actions' | 'aside' | 'commands' | 'new' | 'viewer';
	let {
		session,
		messages,
		typing = '',
		sheet: initialSheet,
		pressed,
		writes = [],
		closing,
		aside,
		archived,
		waiting = 2,
		tray,
		running = false,
		stopping = false,
		connection,
		photos = [],
		quotaFull = false,
		newMessages = false,
		announce,
		toast,
		commandsOffline = false,
		viewer: initialViewer,
		openTurn,
		openStep,
		focusAsk
	}: {
		session: Session;
		messages: ChatMessage[];
		typing?: string;
		sheet?: Sheet;
		pressed?: string;
		writes?: MemoryWrite[];
		closing?: ThreadClose;
		aside?: { question: string; answer: string };
		archived?: string;
		waiting?: number;
		tray?: {
			items: PendingApproval[];
			armed?: boolean;
			state?: 'ready' | 'submitting' | 'timeout';
			details?: boolean;
			collapsed?: boolean;
		};
		running?: boolean;
		stopping?: boolean;
		connection?: ConnectionState;
		photos?: PhotoDraft[];
		quotaFull?: boolean;
		/** The reader is scrolled up and something arrived below. */
		newMessages?: boolean;
		/** Screen-reader announcement, set once when a reply completes. */
		announce?: string;
		/** A transient line above the composer, such as "Nothing to stop". */
		toast?: string;
		commandsOffline?: boolean;
		viewer?: FileRef;
		openTurn?: string;
		openStep?: string;
		focusAsk?: string;
	} = $props();

	// svelte-ignore state_referenced_locally
	let sheet = $state<Sheet | undefined>(initialSheet);
	// svelte-ignore state_referenced_locally
	let viewer = $state<FileRef | undefined>(initialViewer);
	const thread = $derived(session.kind === 'thread');
	const pressedText = $derived(
		messages
			.find((m) => m.id === pressed)
			?.parts.find((p) => p.type === 'text')
			?.text.slice(0, 90)
	);
	const commands = $derived([
		{
			icon: MessageSquarePlus,
			label: 'New chat',
			note: commandsOffline
				? "Can't start a new chat while the agent is offline."
				: 'Archive this conversation and start fresh. The agent keeps its memory.',
			disabled: commandsOffline
		},
		{
			icon: Square,
			label: 'Stop',
			note: running ? 'Stop the turn that is running now.' : 'Nothing is running right now.',
			disabled: commandsOffline || !running
		},
		{
			icon: FoldVertical,
			label: 'Compact',
			note: 'Summarize older messages so the agent has room to work.',
			disabled: commandsOffline
		}
	]);
	const sheetLabels: Record<Sheet, string> = {
		memory: 'Memory shared with Main',
		close: 'Close thread',
		actions: 'Message actions',
		aside: 'Side question',
		commands: 'Chat commands',
		new: 'Start a new chat',
		viewer: 'Image'
	};
</script>

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
		<Composer placeholder="Ask another side question" attach={false} />
	{:else if sheet === 'commands'}
		<div class="flex flex-col gap-2 px-3 pt-1 pb-3">
			<h2 class="px-2 pt-1 text-lg font-semibold">Chat commands</h2>
			{#if commandsOffline}
				<p
					role="status"
					class="mx-2 flex items-start gap-2 rounded-lg bg-waiting-soft px-3 py-2 text-sm text-waiting"
				>
					<ServerOff class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					Can't run commands while the agent is offline.
				</p>
			{/if}
			<ul class="flex flex-col">
				{#each commands as c (c.label)}
					<li>
						<button
							type="button"
							disabled={c.disabled}
							class="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-55"
						>
							<c.icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="flex flex-col gap-0.5">
								<span class="text-[15px] font-medium">{c.label}</span>
								<span class="text-sm text-muted-foreground">{c.note}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{:else if sheet === 'new'}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">Start a new chat?</h2>
				<p class="text-sm text-muted-foreground">
					The agent keeps its memory; this conversation is archived. Starting can take up to 4
					minutes.
				</p>
			</div>
			<div class="flex flex-col gap-2">
				<Button size="lg"><MessageSquarePlus />Start new chat</Button>
				<Button size="lg" variant="ghost">Cancel</Button>
			</div>
		</div>
	{:else if sheet === 'viewer' && viewer?.src}
		<div class="flex flex-col gap-3 px-4 pt-1 pb-4">
			<img src={viewer.src} alt={viewer.name} class="w-full rounded-xl border object-contain" />
			<p class="text-sm [overflow-wrap:anywhere]">
				{viewer.name} <span class="text-muted-foreground">· {viewer.size}</span>
			</p>
			<div class="flex gap-2">
				<Button variant="outline" class="flex-1" href="/f/{viewer.id}" download={viewer.name}
					><Download />Download</Button
				>
				<Button variant="ghost" class="flex-1" onclick={() => (sheet = undefined)}>Close</Button>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet footer()}
	{#if newMessages}
		<div class="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-3">
			<Button
				variant="outline"
				class="pointer-events-auto rounded-full bg-background px-4 shadow-md dark:bg-card"
				><ArrowDown />New messages</Button
			>
		</div>
	{/if}
	{#if toast}
		<p
			role="status"
			class="absolute inset-x-3 bottom-full mb-3 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-lg"
		>
			{toast}
		</p>
	{/if}
	{#if archived}
		<div class="flex items-center gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
			<Archive class="size-4 shrink-0" aria-hidden="true" />
			<span>Archived {archived}. Read only.</span>
			<Button variant="outline" class="ml-auto"><RotateCcw />Reopen</Button>
		</div>
	{:else}
		<div class="border-t">
			{#if tray}<ApprovalTray {...tray} />{/if}
			<Composer
				value={typing}
				placeholder={thread ? `Message in ${session.title}` : 'Message your agent'}
				{running}
				{stopping}
				stop={!tray || !!tray.collapsed}
				{photos}
				{quotaFull}
			/>
		</div>
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
	{#if !archived}
		<Button
			variant="ghost"
			class="size-12 px-0"
			aria-label="Chat commands"
			onclick={() => (sheet = 'commands')}><EllipsisVertical class="size-5" /></Button
		>
	{/if}
{/snippet}

{#snippet banner()}
	{#if connection}<ConnectionBanner state={connection} />{/if}
{/snippet}

<AppShell
	active="chats"
	title={session.title}
	{subtitle}
	back={{ href: '/chats', label: 'Chats' }}
	{waiting}
	{actions}
	{footer}
	{banner}
	sheet={sheet ? sheetBody : undefined}
	sheetLabel={sheet ? sheetLabels[sheet] : undefined}
	onclosesheet={() => (sheet = undefined)}
	stickToBottom
>
	<div class="mx-auto max-w-2xl">
		<Conversation
			{messages}
			{openTurn}
			{openStep}
			{focusAsk}
			onopenfile={(f) => {
				viewer = f;
				sheet = 'viewer';
			}}
		/>
	</div>
	<p role="status" class="sr-only">{announce ?? ''}</p>
</AppShell>
