<script lang="ts" module>
	const expandedInboxes = new Set<string>();
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { onMount, tick, untrack } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { returnTo } from '$lib/core/nav/back';
	import { routedSheet } from '$lib/core/nav/sheet';
	import { closeShownNotifications } from '$lib/core/pwa/notifications';
	import { pwa } from '$lib/core/pwa/pwa.svelte';
	import { hub } from '$lib/core/realtime/hub.svelte';
	import { chatStore } from '$lib/features/chat';
	import {
		conversationInbox,
		inboxConversation,
		deepLinkItem,
		HomeScreen,
		messagePreview,
		needsYou,
		type HomeItem,
		type HomePeek
	} from '$lib/features/home';
	import type { ConnectionState } from '$lib/ui/connection-banner.svelte';

	let {
		threads,
		children
	}: {
		threads: { id: string; title: string }[];
		children: Snippet<[Snippet<[string, string]>, Snippet]>;
	} = $props();

	const home = needsYou();
	home.open();
	const sheet = routedSheet('peek');
	const DEEP_LINK_WAIT_MS = 5000;

	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	const unreachable = $derived(
		!pwa.online || hub.connection === 'forbidden' || hub.connection === 'closed'
	);
	const connection = $derived.by((): ConnectionState | 'forbidden' | undefined => {
		if (!pwa.online) return { kind: 'app-offline' };
		if (hub.connection === 'forbidden') return 'forbidden';
		if (hub.connection === 'reconnecting') return { kind: 'reconnecting' };
		return undefined;
	});

	const greeted = $derived(home.live.greeted);
	const data = home.data;
	const remote = $derived({
		status:
			greeted || data.status === 'ready'
				? ('ready' as const)
				: data.status === 'error'
					? ('error' as const)
					: ('loading' as const),
		slow: data.slow,
		error: data.error
	});

	const items = $derived(Object.values(home.groups).flat());

	/** Whether Home's records could say for sure that this item is gone. */
	function checked(id: string): boolean {
		if (unreachable) return false;
		// Approvals and asks come from the stream's pending list, which is complete once greeted.
		if (id.startsWith('approval:') || id.startsWith('ask:')) return true;
		// The last load failed, or none has finished: the item may still be there.
		if (data.status === 'error' || data.data === undefined) return false;
		// With Home off on the bot there is nothing more to wait for.
		if (data.data === null) return true;
		if (id.startsWith('run:')) return data.data?.workspace.state === 'online';
		return true;
	}
	const peek = $derived.by((): HomePeek | undefined => {
		const id = sheet.arg;
		if (!sheet.open || !id) return undefined;
		const item = items.find((i) => i.id === id);
		const nonce = id.startsWith('approval:') ? id.slice('approval:'.length) : null;
		return {
			id,
			item,
			missing: item ? undefined : checked(id) ? 'handled' : 'offline',
			submitting: nonce ? home.submitting.includes(nonce) : false,
			result: home.results[id]
		};
	});

	// Opening an inbox item reads it; it stays until marked done.
	$effect(() => {
		const id = peek?.item?.group === 'review' ? peek.id : undefined;
		if (id) untrack(() => home.markRead(id));
	});

	// Item ids are the push tags, so opening an item clears its notification.
	$effect(() => {
		const id = peek?.item ? peek.id : undefined;
		if (!id) return;
		void closeShownNotifications(new Set([id])).catch(() => {
			// Nothing to clear if the worker is gone.
		});
	});

	// A push opens /?approve=, /?ask= or /?item=; once Home knows what is waiting, the item opens
	// in its sheet, or the sheet says it was already handled. It never waits for good.
	onMount(() => {
		const target = deepLinkItem(page.url.searchParams);
		if (!target) return;
		let done = false;
		const open = () => {
			if (done) return;
			done = true;
			replaceState(resolve('/chats'), {});
			sheet.openWith(target);
		};
		const timer = setTimeout(open, DEEP_LINK_WAIT_MS);
		const stop = $effect.root(() => {
			$effect(() => {
				const settled = data.status === 'ready' || data.status === 'error';
				if ((greeted && settled) || unreachable) open();
			});
		});
		return () => {
			clearTimeout(timer);
			stop();
		};
	});

	// A navigation that replaced the sheet's shallow entry would leave back on a stale page, so the
	// sheet's entry is popped first and the new screen pushed after it.
	async function leaveTo(href: string) {
		if (sheet.open) {
			const popped = new Promise((r) => addEventListener('popstate', r, { once: true }));
			sheet.close();
			await popped;
			await tick();
		}
		await goto(href);
	}

	// The chat is usually the entry under the inbox: step back to it rather than stack another.
	const openChat = async () => {
		if (sheet.open) {
			const popped = new Promise((r) => addEventListener('popstate', r, { once: true }));
			sheet.close();
			await popped;
			await tick();
		}
		await returnTo(resolve('/chat'));
	};

	function done(id: string) {
		const item = items.find((i) => i.id === id);
		if (!item) return;
		const label =
			item.kind === 'message'
				? messagePreview(item.message.text)
				: item.kind === 'run'
					? item.run.title
					: id;
		home.done(id, label);
		if (sheet.arg === id) sheet.close();
	}

	function reply(item: HomeItem) {
		if (item.kind !== 'message') return;
		const quote = item.message.text.split('\n').map((l) => `> ${l}`);
		chatStore().setDraft(`> From ${item.message.job}:\n${quote.join('\n')}\n\n`);
		void openChat();
	}

	function askAgent(item: HomeItem) {
		if (item.kind !== 'alert') return;
		const a = item.alert;
		const what = a.kind === 'stuck' ? 'is stuck' : 'failed';
		const quote = [`> Scheduled job ${a.job} ${what}`, ...(a.error ? [`> ${a.error}`] : [])];
		chatStore().setDraft(`${quote.join('\n')}\n\n`);
		void openChat();
	}
</script>

{#snippet inbox(id: string, title: string)}
	{@const groups = conversationInbox(
		{ ...home.groups, waiting: [] },
		id,
		threads.map((thread) => thread.id)
	)}
	{@const total = Object.values(groups).reduce((count, items) => count + items.length, 0)}
	{@const needs = groups.waiting.length + groups.failed.length}
	{#if total || id === 'main'}
		<details
			open={expandedInboxes.has(id) ||
				(id === 'main' &&
					(remote.status === 'error' ||
						!!remote.slow ||
						(greeted && !!data.error) ||
						(data.data?.workspace.state !== undefined && data.data.workspace.state !== 'online')))}
			ontoggle={(event) => {
				if (event.currentTarget.open) expandedInboxes.add(id);
				else expandedInboxes.delete(id);
			}}
			data-inbox={id}
			aria-label="Inbox for {title}"
			class="group/inbox min-w-0"
		>
			<summary
				class="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted/60"
			>
				<ChevronDown
					class="size-4 shrink-0 transition-transform group-open/inbox:rotate-180"
					aria-hidden="true"
				/>
				<span
					>{id === 'other-activity' ? 'Other activity' : 'Inbox'}{total
						? ` · ${total}`
						: ' · No updates'}</span
				>
				{#if needs}<span class="ml-auto font-medium text-waiting">{needs} need you</span>{/if}
			</summary>
			<div class="px-2 pt-2 pb-3">
				<HomeScreen
					embedded
					hideSheet
					{groups}
					remote={id === 'main' ? remote : { status: 'ready' }}
					{now}
					partError={id === 'main' && greeted && data.status === 'error' ? data.error : null}
					partLoading={id === 'main' && greeted && data.status === 'loading' && data.slow}
					workspace={id === 'main' ? (data.data?.workspace.state ?? 'online') : 'online'}
					onopen={(id) => {
						home.clearResult(id);
						sheet.openWith(id);
					}}
					onretry={() => void data.refetch()}
					ondone={done}
				/>
			</div>
		</details>
	{/if}
{/snippet}

{#snippet attention()}
	{#if home.groups.waiting.length}
		<section aria-label="Needs you" class="flex flex-col gap-2">
			<h2 class="px-1 text-base font-semibold">Needs you</h2>
			<HomeScreen
				embedded
				hideSheet
				compact
				groups={{ waiting: home.groups.waiting, failed: [], running: [], review: [] }}
				remote={{ status: 'ready' }}
				{now}
				itemContext={(item) => {
					const id = inboxConversation(item, home.groups);
					return id === 'main'
						? 'Main chat'
						: (threads.find((thread) => thread.id === id)?.title ?? 'Other activity');
				}}
				onopen={(id) => {
					home.clearResult(id);
					sheet.openWith(id);
				}}
			/>
		</section>
	{/if}
{/snippet}

{@render children(inbox, attention)}

<HomeScreen
	embedded
	sheetOnly
	groups={home.groups}
	{remote}
	partError={greeted && data.status === 'error' ? data.error : null}
	partLoading={greeted && data.status === 'loading' && data.slow}
	workspace={data.data?.workspace.state ?? 'online'}
	{connection}
	{now}
	{peek}
	updateReady={!!pwa.waiting}
	onopen={(id) => {
		home.clearResult(id);
		sheet.openWith(id);
	}}
	onclose={() => sheet.close()}
	onretry={() => void data.refetch()}
	ondecide={(nonce, d, location) => void home.decide(nonce, d, location)}
	onanswer={(askId, answer, index) => void home.answer(askId, answer, index)}
	ondismiss={(id) => {
		void home.dismiss(id);
		sheet.close();
	}}
	ondone={done}
	onreply={reply}
	undo={home.undoable}
	onundo={() => void home.undo()}
	onopenrun={(id) => void leaveTo(resolve('/runs/[id]', { id }))}
	onopenchat={openChat}
	onaskagent={askAgent}
	onreload={() => pwa.reload()}
/>
