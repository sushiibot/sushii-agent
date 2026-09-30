<script lang="ts" module>
	import House from '@lucide/svelte/icons/house';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Activity from '@lucide/svelte/icons/activity';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Sunrise from '@lucide/svelte/icons/sunrise';
	import Plug from '@lucide/svelte/icons/plug';
	import History from '@lucide/svelte/icons/history';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';

	export const nav = [
		{ id: 'home', href: '/', label: 'Home', icon: House },
		{ id: 'chats', href: '/chats', label: 'Chats', icon: MessagesSquare },
		{ id: 'brief', href: '/brief', label: 'Briefing', icon: Sunrise },
		{ id: 'runs', href: '/runs', label: 'Runs', icon: Activity },
		{ id: 'memory', href: '/memory', label: 'Memory & skills', icon: BookMarked },
		{ id: 'schedules', href: '/schedules', label: 'Schedules', icon: CalendarClock },
		{ id: 'connectors', href: '/connectors', label: 'Connectors', icon: Plug },
		{ id: 'history', href: '/history', label: 'History', icon: History }
	] as const;

	export type NavId = (typeof nav)[number]['id'] | 'more';
	const tabIds: readonly NavId[] = ['home', 'chats', 'brief'];
	const tabs = [
		...nav.filter((n) => tabIds.includes(n.id)),
		{ id: 'more', href: '/more', label: 'More', icon: Ellipsis }
	];
	export const moreItems = nav.filter((n) => !tabIds.includes(n.id));
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import { MediaQuery } from 'svelte/reactivity';
	import { cn } from '$lib/utils';

	let {
		active,
		title,
		subtitle,
		back,
		waiting = 0,
		unread = false,
		actions,
		footer,
		sheet,
		sheetLabel,
		sheetOnDesktop = false,
		toast,
		stickToBottom = false,
		tabBar = true,
		banner,
		scroller = $bindable(null),
		onclosesheet,
		children
	}: {
		active: NavId;
		title: string;
		subtitle?: Snippet;
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void };
		waiting?: number;
		unread?: boolean;
		actions?: Snippet;
		footer?: Snippet;
		sheet?: Snippet;
		sheetLabel?: string;
		/** Show the sheet at desktop widths too, for sheets with no desktop equivalent. */
		sheetOnDesktop?: boolean;
		toast?: Snippet;
		stickToBottom?: boolean;
		tabBar?: boolean;
		banner?: Snippet;
		/** The scrolling message region, for callers that track the reader's position. */
		scroller?: HTMLElement | null;
		/** Tapping outside the sheet calls this; Escape and back are the caller's to wire. */
		onclosesheet?: () => void;
		children: Snippet;
	} = $props();

	// On a phone, More's destinations are pushed screens; the desktop sidebar makes them top level.
	let dialog = $state<HTMLElement | null>(null);
	const wide = new MediaQuery('min-width: 48rem');
	const sheetOpen = $derived(!!sheet);
	const sheetVisible = $derived(sheetOpen && (sheetOnDesktop || !wide.current));

	// The rest of the shell is inert while a sheet is open, which traps focus in the sheet.
	$effect(() => {
		if (!sheetVisible || !dialog) return;
		const opener = document.activeElement;
		const first = dialog.querySelector<HTMLElement>('[data-autofocus]');
		(first ?? dialog).focus({ preventScroll: true });
		return () => {
			if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
				opener.focus({ preventScroll: true });
			}
		};
	});

	// inert keeps Tab out of the page; this wraps it instead of escaping to the browser chrome.
	function wrapTab(e: KeyboardEvent) {
		if (e.key !== 'Tab' || !dialog) return;
		const items = [
			...dialog.querySelectorAll<HTMLElement>(
				'a[href], button:not(:disabled), input:not(:disabled), textarea, select, summary, [tabindex="0"]'
			)
		];
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || active === dialog)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}

	const phoneBack = $derived(
		back ??
			(active !== 'more' && !tabIds.includes(active) ? { href: '/more', label: 'More' } : undefined)
	);
</script>

<div
	class="@container relative h-[calc(100%-var(--kb))] overflow-hidden bg-background pt-(--safe-top) text-foreground"
>
	<div class="flex h-full flex-col @3xl:flex-row" inert={sheetVisible}>
		<nav
			aria-label="Main"
			class="hidden w-56 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-3 @3xl:flex"
		>
			<div class="mb-4 flex items-center gap-2 px-2 pt-1">
				<span class="grid size-7 place-items-center rounded-md bg-foreground text-background">
					<svg viewBox="0 0 16 16" class="size-4" aria-hidden="true"
						><circle
							cx="8"
							cy="8"
							r="5"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						/><circle cx="8" cy="8" r="1.6" fill="currentColor" /></svg
					>
				</span>
				<span class="text-sm font-semibold">Agent</span>
				<span class="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
					<span class="size-1.5 rounded-full bg-review"></span>online
				</span>
			</div>
			{#each nav as item, i (item.id)}
				{#if i === 3}<span class="mx-2 my-2 border-t" aria-hidden="true"></span>{/if}
				<a
					href={item.href}
					aria-current={active === item.id ? 'page' : undefined}
					class={cn(
						'flex h-9 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
						active === item.id && 'bg-sidebar-accent font-medium text-foreground'
					)}
				>
					<item.icon class="size-4" aria-hidden="true" />
					{item.label}
					{#if item.id === 'home' && waiting}
						<span
							class="ml-auto rounded-full bg-waiting-soft px-1.5 text-xs font-semibold text-waiting tabular-nums"
							>{waiting}</span
						>
					{:else if item.id === 'chats' && unread}
						<span class="ml-auto size-2 rounded-full bg-brand"
							><span class="sr-only">Unread</span></span
						>
					{/if}
				</a>
			{/each}
		</nav>

		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<header class="flex min-h-13 shrink-0 items-center gap-1 border-b px-2 py-1 @3xl:px-5">
				{#if phoneBack}
					<a
						href={phoneBack.href}
						onclick={back?.onclick}
						class={cn(
							'-ml-0.5 flex h-12 min-w-12 shrink-0 items-center rounded-md pr-1.5 pl-0.5 text-sm text-muted-foreground hover:text-foreground',
							!back && '@3xl:hidden'
						)}
					>
						<ChevronLeft class="size-5" aria-hidden="true" /><span class="sr-only @3xl:not-sr-only"
							>{phoneBack.label}</span
						>
					</a>
				{/if}
				<div class={cn('flex min-w-0 flex-col', !phoneBack && 'pl-2', !back && '@3xl:pl-0')}>
					<h1 class="truncate text-base leading-tight font-semibold">{title}</h1>
					{@render subtitle?.()}
				</div>
				<div class="ml-auto flex shrink-0 items-center gap-1">{@render actions?.()}</div>
			</header>
			{@render banner?.()}

			<!-- column-reverse keeps a chat pinned to its newest message without scripting. -->
			<main
				bind:this={scroller}
				class={cn(
					'@container min-h-0 flex-1 overflow-y-auto overscroll-contain',
					stickToBottom && 'flex flex-col-reverse'
				)}
			>
				<div class={stickToBottom ? 'shrink-0' : 'h-full'}>{@render children()}</div>
			</main>

			<div class="relative shrink-0 bg-background pb-(--safe-bottom) @3xl:pb-0 kb:pb-0">
				{#if toast}
					<div
						role="status"
						class="absolute inset-x-3 bottom-full mb-3 flex items-center gap-3 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-lg @3xl:right-auto @3xl:left-6 @3xl:w-96"
					>
						{@render toast()}
					</div>
				{/if}
				{@render footer?.()}
				{#if tabBar && !phoneBack}
					<nav
						aria-label="Main"
						class="grid grid-cols-4 border-t select-none [-webkit-touch-callout:none] @3xl:hidden kb:hidden"
					>
						{#each tabs as item (item.id)}
							{@const current = active === item.id}
							<a
								href={item.href}
								aria-current={current ? 'page' : undefined}
								class={cn(
									'relative flex h-14 flex-col items-center justify-center gap-1 text-tab text-muted-foreground',
									current && 'font-semibold text-foreground'
								)}
							>
								<item.icon class="size-5" aria-hidden="true" strokeWidth={current ? 2.25 : 1.75} />
								{item.label}
								{#if item.id === 'home' && waiting}
									<span
										class="absolute top-1.5 left-1/2 ml-1.5 min-w-4 rounded-full bg-waiting px-1 text-center text-tab leading-4 font-semibold text-background tabular-nums"
										>{waiting}<span class="sr-only"> waiting</span></span
									>
								{:else if item.id === 'chats' && unread}
									<span class="absolute top-2 left-1/2 ml-2 size-2 rounded-full bg-brand"
										><span class="sr-only">Unread</span></span
									>
								{/if}
							</a>
						{/each}
					</nav>
				{/if}
			</div>
		</div>
	</div>

	{#if sheet}
		<div
			class={cn(
				'absolute inset-0 z-20 flex flex-col justify-end',
				sheetOnDesktop ? '@3xl:items-center @3xl:justify-center @3xl:p-6' : '@3xl:hidden'
			)}
		>
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div class="absolute inset-0 bg-scrim" aria-hidden="true" onclick={onclosesheet}></div>
			<div
				bind:this={dialog}
				role="dialog"
				aria-modal="true"
				aria-label={sheetLabel}
				tabindex="-1"
				onkeydown={wrapTab}
				class={cn(
					'relative flex max-h-[88%] flex-col overflow-y-auto overscroll-contain rounded-t-3xl bg-background pb-(--safe-bottom) shadow-[0_-12px_40px_-12px_rgb(0_0_0/0.4)] outline-none kb:pb-0',
					sheetOnDesktop && '@3xl:w-full @3xl:max-w-md @3xl:rounded-3xl @3xl:pb-0'
				)}
			>
				<span
					class={cn(
						'mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/35',
						sheetOnDesktop && '@3xl:invisible'
					)}
				></span>
				{@render sheet()}
			</div>
		</div>
	{/if}
</div>
