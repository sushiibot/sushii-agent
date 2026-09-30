<script lang="ts">
	import type { Snippet } from 'svelte';
	import Split from '@lucide/svelte/icons/split';
	import Bell from '@lucide/svelte/icons/bell';
	import Archive from '@lucide/svelte/icons/archive';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Clock from '@lucide/svelte/icons/clock';
	import Check from '@lucide/svelte/icons/check';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { cn } from '$lib/utils';
	import AskCard from './ask-card.svelte';
	import FilesBlock from './files-block.svelte';
	import Markdown from './markdown.svelte';
	import WorkingRow from './working-row.svelte';
	import { longPress } from './long-press';
	import { hasText } from './render/plain-text';
	import type { ApprovalOutcome, ChatMessage, Delivery, FileRef, MessagePart, Turn } from './types';

	let {
		messages,
		pressed,
		after,
		openTurn,
		openStep,
		focusAsk,
		onopenfile,
		onretrysend,
		ondeletesend,
		onanswer,
		onretryhistory,
		onmessagemenu,
		selecting
	}: {
		messages: ChatMessage[];
		pressed?: string;
		after?: Snippet;
		/** Message id whose working row or divider starts expanded. */
		openTurn?: string;
		openStep?: string;
		focusAsk?: string;
		onopenfile?: (file: FileRef) => void;
		onretrysend?: (messageId: string) => void;
		ondeletesend?: (messageId: string) => void;
		onanswer?: (askId: string, answer: string) => void;
		onretryhistory?: () => void;
		/** Opens the actions sheet for a message; without it messages have no menu. */
		onmessagemenu?: (messageId: string) => void;
		/** The message whose text is in select mode, where holding it selects text natively. */
		selecting?: string;
	} = $props();

	// Holding a bubble opens its menu, so on touch screens the hold must not start a native selection.
	const holdable = 'pointer-coarse:select-none [-webkit-touch-callout:none]';

	function openHeld(el: HTMLElement) {
		const id = el.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
		if (id) onmessagemenu?.(id);
	}

	// Enter, Shift+F10 or the menu key on a focused message; keys inside it (links, buttons) pass.
	const keyMenu = (node: HTMLElement) => {
		const onKey = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement;
			if (!el.matches?.('[data-message-focus]')) return;
			const menuKey = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
			if (e.key !== 'Enter' && !menuKey) return;
			e.preventDefault();
			openHeld(el);
		};
		const onContextMenu = (e: MouseEvent) => {
			const el = e.target as HTMLElement;
			if (!el.matches?.('[data-message-focus]')) return;
			e.preventDefault();
			openHeld(el);
		};
		node.addEventListener('keydown', onKey);
		node.addEventListener('contextmenu', onContextMenu);
		return () => {
			node.removeEventListener('keydown', onKey);
			node.removeEventListener('contextmenu', onContextMenu);
		};
	};
	const uid = $props.id();

	const isTool = (p: MessagePart) => p.type.startsWith('tool-');
	// Tool parts from SDK-shaped messages collapse into one finished turn row.
	function toolTurn(parts: MessagePart[]): Turn {
		return {
			state: 'done',
			steps: parts.flatMap((p) =>
				p.type.startsWith('tool-') && 'toolCallId' in p
					? [
							{
								id: p.toolCallId,
								tool: p.type.slice(5),
								label: p.output?.found ?? p.type.slice(5),
								state: p.state === 'output-denied' ? ('failed' as const) : ('ok' as const),
								input: JSON.stringify(p.input, null, 2),
								output: p.output ? JSON.stringify(p.output, null, 2) : undefined
							}
						]
					: []
			)
		};
	}

	const delivery: Record<Delivery, { icon: typeof Check; text: string; tone?: string }> = {
		sending: { icon: Clock, text: 'Sending' },
		sent: { icon: Check, text: 'Sent' },
		failed: { icon: CircleAlert, text: 'Failed', tone: 'text-failed' },
		queued: { icon: CloudOff, text: "Queued, sends when you're back online", tone: 'text-waiting' },
		'queued-agent': {
			icon: CloudOff,
			text: 'Queued, sends when the agent is back',
			tone: 'text-waiting'
		}
	};
	const outcome: Record<ApprovalOutcome, string> = {
		pending: 'Approval requested',
		approved: 'Approved',
		denied: 'Denied',
		timeout: 'Timed out, denied',
		cancelled: 'No longer needed',
		'approved-elsewhere': 'Approved on another device',
		'denied-elsewhere': 'Denied on another device'
	};
</script>

{#snippet actionsButton(id: string, extra: string)}
	<button
		type="button"
		aria-label="Message actions"
		aria-haspopup="dialog"
		data-message-actions
		onclick={() => onmessagemenu?.(id)}
		class={cn(
			'pointer-events-none absolute top-0 grid size-12 place-items-center rounded-lg border bg-background text-muted-foreground opacity-0 shadow-sm group-focus-visible/msg:pointer-events-auto group-focus-visible/msg:opacity-100 group-has-[:focus-visible]/msg:pointer-events-auto group-has-[:focus-visible]/msg:opacity-100 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
			extra
		)}
	>
		<Ellipsis class="size-4" aria-hidden="true" />
	</button>
{/snippet}

<ol
	class="flex flex-col gap-4 px-4 py-4"
	{@attach longPress('[data-holdable]', openHeld)}
	{@attach keyMenu}
>
	{#each messages as message (message.id)}
		{@const owner = message.role === 'user' && !message.unverified}
		{@const firstTool = message.parts.findIndex(isTool)}
		{@const menu = !!onmessagemenu && !message.streaming && hasText(message)}
		{@const hold = menu && selecting !== message.id}
		{@const failed = message.delivery === 'failed'}
		<li data-message-id={message.id}>
			<!-- A focusable article, as in the ARIA feed pattern: the keyboard path to the actions sheet. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				role={menu ? 'article' : undefined}
				tabindex={menu ? 0 : undefined}
				aria-label={menu ? (owner ? 'Your message' : 'Agent message') : undefined}
				aria-keyshortcuts={menu ? 'Enter Shift+F10' : undefined}
				data-message-focus={menu || undefined}
				class={cn(
					'group/msg relative rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-4 focus-visible:ring-offset-background focus-visible:outline-none',
					owner ? 'flex flex-col items-end gap-2' : 'flex flex-col gap-2',
					pressed === message.id &&
						'-mx-2 bg-muted px-2 py-2 ring-2 ring-brand/50 transition-colors'
				)}
			>
				{#if message.unverified}
					<span class="text-xs text-muted-foreground"
						>{message.role === 'user' ? 'You · ' : ''}from workspace history (unverified)</span
					>
				{/if}
				{#each message.parts as part, i (i)}
					{#if part.type === 'text' && message.role === 'assistant'}
						<div
							data-message-text
							data-holdable={hold || undefined}
							class={cn(
								hold && holdable,
								message.streaming &&
									"min-h-[4.5lh] [&_p:last-child]:after:ml-0.5 [&_p:last-child]:after:inline-block [&_p:last-child]:after:h-[1.1em] [&_p:last-child]:after:w-0.5 [&_p:last-child]:after:translate-y-[3px] [&_p:last-child]:after:animate-pulse [&_p:last-child]:after:bg-foreground [&_p:last-child]:after:content-[''] motion-reduce:[&_p:last-child]:after:animate-none"
							)}
						>
							<Markdown text={part.text} streaming={message.streaming} files={message.uploads} />
						</div>
					{:else if part.type === 'text'}
						<p
							data-message-text
							data-holdable={hold || undefined}
							class={cn(
								'whitespace-pre-wrap',
								hold && holdable,
								owner
									? 'max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[15px] leading-snug text-primary-foreground'
									: message.role === 'user'
										? 'rounded-2xl border border-dashed px-3.5 py-2 text-[15px] leading-snug'
										: 'text-[15px] leading-relaxed [overflow-wrap:anywhere]',
								message.streaming &&
									"min-h-[4.5lh] after:ml-0.5 after:inline-block after:h-[1.1em] after:w-0.5 after:translate-y-[3px] after:animate-pulse after:bg-foreground after:content-[''] motion-reduce:after:animate-none"
							)}
						>
							{part.text}
						</p>
					{:else if part.type === 'data-auth'}
						<p class="text-[15px] leading-relaxed [overflow-wrap:anywhere]">
							{part.data.instructions}
							{#if part.data.https}<a
									href={part.data.url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-brand underline">Open the login page</a
								>{:else}<code class="font-mono text-[13px]">{part.data.url}</code>{/if}
						</p>
					{:else if part.type === 'data-turn'}
						<WorkingRow turn={part.data} open={openTurn === message.id} {openStep} />
					{:else if part.type === 'data-approval'}
						<p data-approval class="flex items-center gap-2 text-sm text-muted-foreground">
							<ShieldCheck class="size-4 shrink-0 text-approval" aria-hidden="true" />
							<span
								>{outcome[part.data.outcome]}{part.data.outcome === 'pending' ? ':' : ' ·'}
								<code class="font-mono text-[13px] text-foreground">{part.data.tool}</code></span
							>
						</p>
					{:else if part.type === 'data-ask'}
						<AskCard
							ask={part.data}
							focused={focusAsk === part.data.askId}
							onanswer={(answer) => onanswer?.(part.data.askId, answer)}
						/>
					{:else if part.type === 'data-files'}
						<FilesBlock files={part.data.files} dropped={part.data.dropped} onopen={onopenfile} />
					{:else if part.type === 'data-divider'}
						{@const label = {
							new: 'New chat',
							rotated: 'Conversation continued',
							compacted: 'Conversation compacted'
						}[part.data.kind]}
						{#if part.data.summary}
							<details open={openTurn === message.id} class="group/div w-full text-sm">
								<summary
									class="flex min-h-12 cursor-pointer list-none items-center gap-3 text-muted-foreground [&::-webkit-details-marker]:hidden"
								>
									<span class="h-px flex-1 bg-border"></span>
									<span class="flex items-center gap-1 font-medium"
										>{label}<ChevronDown
											class="size-3.5 transition-transform group-open/div:rotate-180 motion-reduce:transition-none"
											aria-hidden="true"
										/></span
									>
									<span class="h-px flex-1 bg-border"></span>
								</summary>
								<p class="rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed">
									{part.data.summary}
								</p>
							</details>
						{:else}
							<p
								class="flex w-full items-center gap-3 py-2 text-sm font-medium text-muted-foreground"
							>
								<span class="h-px flex-1 bg-border"></span>{label}<span
									class="h-px flex-1 bg-border"
								></span>
							</p>
						{/if}
					{:else if part.type === 'data-history-gap'}
						<p
							class="flex w-full items-center justify-between gap-3 rounded-lg border border-dashed py-1 pr-1 pl-3 text-sm text-muted-foreground"
						>
							Earlier messages unavailable right now
							<Button variant="ghost" class="px-3" onclick={onretryhistory}
								><RotateCcw />Retry</Button
							>
						</p>
					{:else if part.type === 'data-line'}
						<p class="text-sm text-muted-foreground">{part.data.text}</p>
					{:else if part.type === 'data-notice'}
						<a
							href={part.data.href}
							class="flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-2.5 text-sm hover:bg-muted/50"
						>
							<Bell class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="flex min-w-0 flex-col gap-0.5">
								<span class="text-xs font-medium text-muted-foreground">{part.data.source}</span>
								<span>{part.data.items.join(' · ')}</span>
							</span>
						</a>
					{:else if part.type === 'data-thread-offer'}
						<section
							aria-label="Thread suggestion"
							class="flex flex-col gap-3 rounded-xl border border-brand/40 bg-card p-3.5 shadow-[0_6px_20px_-14px_rgb(0_0_0/0.35)]"
						>
							<p class="flex items-center gap-2 text-sm font-semibold">
								<span class="grid size-7 place-items-center rounded-md bg-brand/12 text-brand">
									<Split class="size-4" aria-hidden="true" />
								</span>
								Start a thread: {part.data.title}
							</p>
							<p class="text-sm text-muted-foreground">{part.data.reason}</p>
							{#if part.data.openedAs}
								<a
									href="/chats/{part.data.openedAs}"
									class="inline-flex items-center gap-1 self-start text-sm font-medium text-brand hover:underline"
									>Moved to the thread<ArrowUpRight class="size-3.5" aria-hidden="true" /></a
								>
							{:else}
								<div class="flex flex-wrap gap-2">
									<Button size="lg"><Split />Start thread</Button>
									<Button size="lg" variant="ghost">Keep it here</Button>
								</div>
							{/if}
						</section>
					{:else if part.type === 'data-thread-brief'}
						<section
							aria-labelledby="{uid}-brief-{message.id}"
							class="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3.5 text-sm"
						>
							<h2
								id="{uid}-brief-{message.id}"
								class="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
							>
								From Main
							</h2>
							<div class="flex flex-col gap-1">
								<h3 class="font-medium">What's known</h3>
								<ul
									class="flex list-disc flex-col gap-1 pl-5 text-muted-foreground marker:text-border"
								>
									{#each part.data.known as line, j (j)}<li>{line}</li>{/each}
								</ul>
							</div>
							<div class="flex flex-col gap-1">
								<h3 class="font-medium">Open questions</h3>
								<ul
									class="flex list-disc flex-col gap-1 pl-5 text-muted-foreground marker:text-border"
								>
									{#each part.data.open as line, j (j)}<li>{line}</li>{/each}
								</ul>
							</div>
							<label class="flex items-center justify-between gap-3 border-t pt-3">
								<span class="flex flex-col">
									<span>Include the last {part.data.recentFromMain} messages</span>
									<span class="text-xs text-muted-foreground"
										>Off: the thread starts from this brief only</span
									>
								</span>
								<Switch />
							</label>
						</section>
					{:else if part.type === 'data-thread-report'}
						<a
							href="/chats/{part.data.sessionId}"
							class="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm hover:bg-muted/50"
						>
							<Archive class="mt-0.5 size-4 shrink-0 text-review" aria-hidden="true" />
							<span class="flex min-w-0 flex-col gap-0.5">
								<span class="text-xs text-muted-foreground"
									>Thread closed · <span class="font-medium text-foreground">{part.data.title}</span
									></span
								>
								<span>{part.data.line}</span>
							</span>
							<ArrowUpRight
								class="mt-0.5 ml-auto size-4 shrink-0 text-muted-foreground"
								aria-label="View archived thread"
							/>
						</a>
					{:else if part.type === 'data-memory-write'}
						<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
							<BookMarked class="size-3.5 shrink-0" aria-hidden="true" />
							Saved to memory
							<code class="truncate font-mono text-[11px] text-foreground/80">{part.data.file}</code
							>
						</p>
					{:else if isTool(part) && i === firstTool}
						<WorkingRow turn={toolTurn(message.parts)} open={openTurn === message.id} {openStep} />
					{/if}
				{/each}
				{#if message.delivery}
					{@const d = delivery[message.delivery]}
					<p class={cn('flex items-center gap-1 text-xs text-muted-foreground', d.tone)}>
						<d.icon class="size-3.5 shrink-0" aria-hidden="true" />{d.text}
					</p>
				{/if}
				{#if failed}
					<div class="flex gap-2">
						<Button variant="ghost" class="px-3" onclick={() => ondeletesend?.(message.id)}
							><Trash2 />Delete</Button
						>
						<Button variant="outline" class="px-4" onclick={() => onretrysend?.(message.id)}
							><RotateCcw />Retry send</Button
						>
					</div>
				{/if}
				{#if menu}{@render actionsButton(message.id, owner ? 'left-0' : 'right-0')}{/if}
			</div>
		</li>
	{/each}
	{#if after}<li class="flex flex-col gap-2">{@render after()}</li>{/if}
</ol>
