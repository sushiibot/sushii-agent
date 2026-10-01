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
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Copy from '@lucide/svelte/icons/copy';
	import Share2 from '@lucide/svelte/icons/share-2';
	import { Button } from '$lib/ui/button';
	import { Switch } from '$lib/ui/switch';
	import { cn } from '$lib/utils';
	import AskCard from './ask-card.svelte';
	import FilesBlock from './files-block.svelte';
	import Markdown from '../render/markdown.svelte';
	import WorkingRow from './working-row.svelte';
	import MessageActions, { type MessageAction } from './message-actions.svelte';
	import { hasText } from '../render/plain-text';
	import type {
		ApprovalOutcome,
		ChatMessage,
		Delivery,
		FileRef,
		MessagePart,
		Turn
	} from '../types';

	let {
		messages,
		after,
		openTurn,
		openStep,
		focusAsk,
		onopenfile,
		onretrysend,
		ondeletesend,
		onanswer,
		onretryhistory,
		oncopy,
		onshare,
		copied
	}: {
		messages: ChatMessage[];
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
		/** Copy under each message; without it messages have no action row. */
		oncopy?: (message: ChatMessage) => void;
		/** Share, where the browser can. */
		onshare?: (message: ChatMessage) => void;
		/** The message just copied, whose Copy shows a check for a moment. */
		copied?: string;
	} = $props();

	// The newest finished reply keeps its actions in view; older ones show them on hover or focus.
	const latestReply = $derived(
		messages.findLast((m) => m.role === 'assistant' && !m.streaming && hasText(m))?.id
	);

	function actionsFor(message: ChatMessage): MessageAction[] {
		if (!oncopy) return [];
		const copy: MessageAction = {
			id: 'copy',
			label: message.role === 'user' ? 'Copy your message' : 'Copy reply',
			icon: copied === message.id ? Check : Copy,
			onclick: () => oncopy(message)
		};
		if (message.role === 'user' || !onshare) return [copy];
		return [
			copy,
			{ id: 'share', label: 'Share reply', icon: Share2, onclick: () => onshare(message) }
		];
	}

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

<ol class="flex min-w-0 flex-col gap-4 overflow-x-clip px-4 py-4 [overflow-wrap:anywhere]">
	{#each messages as message (message.id)}
		{@const owner = message.role === 'user'}
		{@const firstTool = message.parts.findIndex(isTool)}
		{@const failed = message.delivery === 'failed'}
		{@const queued = message.delivery === 'queued' || message.delivery === 'queued-agent'}
		{@const unsent = owner && (failed || queued)}
		{@const actions = hasText(message) ? actionsFor(message) : []}
		<li data-message-id={message.id} class="min-w-0">
			<div
				class={cn(
					'group/msg relative',
					owner
						? // With a mouse the actions sit beside the bubble, so the column hugs it.
							'flex flex-col items-end gap-2 [@media(hover:hover)]:ml-auto [@media(hover:hover)]:w-fit [@media(hover:hover)]:max-w-[85%]'
						: 'flex flex-col gap-2'
				)}
			>
				{#each message.parts as part, i (i)}
					{#if part.type === 'text' && message.role === 'assistant'}
						<div data-message-text>
							<Markdown text={part.text} streaming={message.streaming} files={message.uploads} />
						</div>
					{:else if part.type === 'text'}
						<p
							data-message-text
							class={cn(
								'[overflow-wrap:anywhere] whitespace-pre-wrap',
								owner
									? 'max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-body leading-snug text-primary-foreground [@media(hover:hover)]:max-w-full'
									: 'text-body leading-relaxed',
								message.streaming &&
									"min-h-[4.5lh] after:ml-0.5 after:inline-block after:h-[1.1em] after:w-0.5 after:translate-y-[3px] after:animate-pulse after:bg-foreground after:content-[''] motion-reduce:after:animate-none"
							)}
						>
							{part.text}
						</p>
					{:else if part.type === 'data-auth'}
						<p class="text-body leading-relaxed [overflow-wrap:anywhere]">
							{part.data.instructions}
							{#if part.data.https}<a
									href={part.data.url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-brand underline">Open the login page</a
								>{:else}<code class="font-mono text-code">{part.data.url}</code>{/if}
						</p>
					{:else if part.type === 'data-turn'}
						<WorkingRow turn={part.data} open={openTurn === message.id} {openStep} />
					{:else if part.type === 'data-approval'}
						<p data-approval class="flex items-center gap-2 text-sm text-muted-foreground">
							<ShieldCheck class="size-4 shrink-0 text-approval" aria-hidden="true" />
							<span class="min-w-0 [overflow-wrap:anywhere]"
								>{outcome[part.data.outcome]}{part.data.outcome === 'pending' ? ':' : ' ·'}
								<code class="font-mono text-code text-foreground">{part.data.tool}</code></span
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
						<p class="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-muted-foreground">
							{part.data.text}
						</p>
					{:else if part.type === 'data-alert'}
						{@const a = part.data}
						<p
							class="flex items-start gap-2 text-sm [overflow-wrap:anywhere] text-muted-foreground"
						>
							<CalendarClock
								class={cn('mt-0.5 size-4 shrink-0', a.kind !== 'recovered' && 'text-failed')}
								aria-hidden="true"
							/>
							<span class="min-w-0">
								<span class="font-medium text-foreground"
									>Scheduled job {a.job}
									{a.kind === 'failed'
										? 'failed'
										: a.kind === 'stuck'
											? 'is stuck'
											: 'is working again'}</span
								>{#if a.error}: {a.error}{/if}
								{#if a.href}
									<a href={a.href} class="font-medium text-foreground underline underline-offset-4"
										>Details</a
									>
								{/if}
							</span>
						</p>
					{:else if part.type === 'data-notice'}
						<a
							href={part.data.href}
							class="flex min-w-0 items-start gap-2.5 rounded-lg border border-dashed px-3 py-2.5 text-sm [overflow-wrap:anywhere] hover:bg-muted/50"
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
							<code class="truncate font-mono text-tab text-foreground/80">{part.data.file}</code>
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
				{#if unsent}
					<div class="flex gap-2">
						{#each actions as a (a.id)}
							<Button
								variant="ghost"
								class="size-12 px-0"
								aria-label={a.label}
								title={a.label}
								onclick={a.onclick}><a.icon aria-hidden="true" /></Button
							>
						{/each}
						<Button variant="ghost" class="px-3" onclick={() => ondeletesend?.(message.id)}
							><Trash2 />Delete</Button
						>
						<Button variant="outline" class="px-4" onclick={() => onretrysend?.(message.id)}
							><RotateCcw />Retry send</Button
						>
					</div>
				{/if}
				{#if actions.length && !unsent}
					<MessageActions
						{actions}
						label={owner ? 'Actions for your message' : 'Actions for the reply'}
						always={message.id === latestReply}
						align={owner ? 'end' : 'start'}
						pending={message.streaming}
						beside={owner}
					/>
				{/if}
			</div>
		</li>
	{/each}
	{#if after}<li class="flex flex-col gap-2">{@render after()}</li>{/if}
</ol>
