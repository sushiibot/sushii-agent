<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import Pencil from '@lucide/svelte/icons/pencil';
	import ThreadSettingsSheet from './components/thread-settings-sheet.svelte';
	import Archive from '@lucide/svelte/icons/archive';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { ChatScreen } from '$lib/features/chat';
	import { Button } from '$lib/ui/button';
	import DetailScreen from '$lib/ui/screen/detail-screen.svelte';
	import type { RemoteLike } from '$lib/ui/screen/screen-state.svelte';
	import RoutedSheet from '$lib/ui/sheet/routed-sheet.svelte';
	import { Skeleton } from '$lib/ui/skeleton';
	import type { MemoryWrite, ThreadDetail, ThreadSheet } from './types';

	type ChatProps = ComponentProps<typeof ChatScreen>;

	let {
		remote,
		detail,
		chat,
		back,
		sheet,
		busy = false,
		error = null,
		sendable = true,
		writeHref = (id) => `/memory/writes/${id}`,
		memoryHref = '/memory/writes',
		onopensheet,
		onclosesheet,
		onclose,
		onrename,
		onretry
	}: {
		remote: RemoteLike;
		/** null: no such thread. */
		detail?: ThreadDetail | null;
		/** The chat screen's props for this thread's conversation. */
		chat?: Omit<
			ChatProps,
			| 'title'
			| 'placeholder'
			| 'subtitle'
			| 'headerActions'
			| 'commandActions'
			| 'readOnly'
			| 'back'
		>;
		now: number;
		back: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		sheet?: ThreadSheet | ChatProps['sheet'];
		busy?: boolean;
		error?: string | null;
		/** Messages can be sent here; false until the agent runs threads. */
		sendable?: boolean;
		writeHref?: (id: string) => string;
		memoryHref?: string;
		onopensheet?: (sheet: ThreadSheet) => void;
		onclosesheet?: () => void;
		onclose?: () => void;
		onrename?: (title: string) => void;
		onreopen?: () => void;
		onretry?: () => void;
	} = $props();

	const thread = $derived(detail?.summary);
	const archived = $derived(thread?.state === 'archived');
	const threadSheet = $derived(
		sheet === 'thread-memory' || sheet === 'thread-close' ? sheet : undefined
	);
	const CHAT_SHEETS: readonly string[] = ['commands', 'new', 'viewer', 'model'];
	const chatSheet = $derived(
		sheet && CHAT_SHEETS.includes(sheet) ? (sheet as ChatProps['sheet']) : undefined
	);
	// A closing sheet keeps its content until it has slid away.
	// svelte-ignore state_referenced_locally
	let shown = $state<ThreadSheet | undefined>(threadSheet);
	$effect.pre(() => {
		if (threadSheet) shown = threadSheet;
	});
</script>

{#snippet writeList(items: MemoryWrite[])}
	<ul class="flex flex-col divide-y rounded-xl border">
		{#each items as w (w.id)}
			<li>
				<a
					href={writeHref(w.id)}
					class="flex min-h-12 items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50"
				>
					<span class="flex min-w-0 flex-col gap-0.5">
						<span class="[overflow-wrap:anywhere]">{w.summary}</span>
						<span class="font-mono text-meta [overflow-wrap:anywhere] text-muted-foreground"
							>{w.file} · {w.when}</span
						>
					</span>
					<ChevronRight class="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet subtitle()}
	{#if thread}
		<button
			type="button"
			aria-haspopup="dialog"
			onclick={() => onopensheet?.('thread-memory')}
			class="-my-3 flex h-12 max-w-full items-center gap-1 self-start truncate text-left text-meta text-muted-foreground hover:text-foreground"
		>
			<BookMarked class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="truncate"
				>{thread.memoryTracking === false
					? 'Shares memory with Main'
					: `Shares memory with Main · ${thread.writes} ${thread.writes === 1 ? 'write' : 'writes'}`}</span
			>
		</button>
	{/if}
{/snippet}

{#snippet commandActions()}
	<div class="flex flex-col border-b pb-2">
		<Button
			variant="ghost"
			size="lg"
			class="justify-start"
			onclick={() => onopensheet?.('thread-settings')}><Pencil />Rename thread</Button
		>
		{#if !archived}
			<Button
				variant="ghost"
				size="lg"
				class="justify-start"
				onclick={() => onopensheet?.('thread-close')}><Archive />Archive thread</Button
			>
		{/if}
	</div>
{/snippet}

{#snippet readOnly()}
	{#if !archived && !sendable}
		<p class="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
			<Archive class="size-4 shrink-0" aria-hidden="true" />
			Read only for now: the agent can't take messages in threads yet.
		</p>
	{/if}
{/snippet}

{#snippet skeleton()}
	<div class="flex flex-col gap-4 px-4 py-4" aria-hidden="true">
		<Skeleton class="h-28 w-full rounded-xl" />
		<Skeleton class="h-10 w-3/5 self-end rounded-2xl" />
		<Skeleton class="h-16 w-4/5 rounded-2xl" />
	</div>
	<p role="status" class="sr-only">Loading the thread…</p>
{/snippet}

{#if thread && chat}
	<ChatScreen
		{...chat}
		sheet={chatSheet}
		title={thread.title}
		placeholder="Message in {thread.title}"
		{subtitle}
		{commandActions}
		readOnly={!sendable ? readOnly : undefined}
		back={{ ...back, desktop: true }}
	/>
{:else}
	<DetailScreen
		title={detail === null ? 'Thread' : 'Loading thread'}
		{back}
		state={{
			remote: detail === null ? { status: 'ready' } : remote,
			isEmpty: detail === null,
			empty: {
				title: 'No such thread',
				body: 'Return to Threads to choose another conversation.'
			},
			errorTitle: "Couldn't load this thread.",
			onretry,
			skeleton
		}}
	>
		<span></span>
	</DetailScreen>
{/if}

<RoutedSheet
	open={!!threadSheet}
	label={shown === 'thread-close' ? 'Archive thread' : 'Memory shared with Main'}
	onclose={() => onclosesheet?.()}
>
	{#if shown === 'thread-memory' && detail}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">Shares memory with Main</h2>
				<p class="text-sm text-muted-foreground">
					This thread has its own conversation but reads and writes the same memory as Main.
					{#if thread?.memoryTracking !== false}Its writes are tagged with the thread, so you can
						check or undo them.{:else}Memory changes stay available after you archive the thread.{/if}
				</p>
			</div>
			{#if detail.writes.length}
				<h3 class="text-sm font-medium">
					{detail.writes.length}
					{detail.writes.length === 1 ? 'write' : 'writes'} from this thread
				</h3>
				{@render writeList(detail.writes)}
			{:else if thread?.memoryTracking !== false}
				<p class="text-sm text-muted-foreground">Nothing written to memory from this thread yet.</p>
			{/if}
			{#if thread?.memoryTracking !== false}<Button variant="outline" size="lg" href={memoryHref}
					>All memory changes</Button
				>{/if}
		</div>
	{:else if shown === 'thread-close' && detail}
		<div class="flex flex-col gap-4 px-5 pt-2 pb-5">
			<div class="flex flex-col gap-1">
				<h2 class="text-lg font-semibold">Archive {detail.summary.title}?</h2>
				<p class="text-sm text-muted-foreground">
					Move this thread into the visible Archived section. Its history stays available; send a
					message whenever you want to continue.
				</p>
			</div>
			{#if error}<p role="alert" class="text-sm text-failed">Couldn't archive it. {error}</p>{/if}
			<div class="flex flex-col gap-2 pt-1">
				<Button size="lg" disabled={busy} onclick={onclose}>
					{#if busy}<LoaderCircle
							class="animate-spin motion-reduce:animate-none"
							aria-hidden="true"
						/>Archiving…{:else}<Archive />Archive thread{/if}
				</Button>
				<Button size="lg" variant="ghost" onclick={() => onclosesheet?.()}>Keep current</Button>
			</div>
		</div>
	{/if}
</RoutedSheet>

<ThreadSettingsSheet
	open={sheet === 'thread-settings'}
	{thread}
	{busy}
	{error}
	{onrename}
	onarchive={onclose}
	onclose={onclosesheet}
/>
