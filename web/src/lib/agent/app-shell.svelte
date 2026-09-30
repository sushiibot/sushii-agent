<script lang="ts" module>
	import Inbox from '@lucide/svelte/icons/inbox';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Activity from '@lucide/svelte/icons/activity';
	import BookMarked from '@lucide/svelte/icons/book-marked';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import Sunrise from '@lucide/svelte/icons/sunrise';
	import Plug from '@lucide/svelte/icons/plug';
	import History from '@lucide/svelte/icons/history';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';

	export const nav = [
		{ id: 'home', href: '/', label: 'Needs you', icon: Inbox },
		{ id: 'chat', href: '/chat', label: 'Chat', icon: MessagesSquare },
		{ id: 'runs', href: '/runs', label: 'Runs', icon: Activity },
		{ id: 'brief', href: '/brief', label: 'Briefing', icon: Sunrise },
		{ id: 'memory', href: '/memory', label: 'Memory', icon: BookMarked },
		{ id: 'schedules', href: '/schedules', label: 'Schedules', icon: CalendarClock },
		{ id: 'connectors', href: '/connectors', label: 'Connectors', icon: Plug },
		{ id: 'history', href: '/history', label: 'History', icon: History }
	] as const;

	export type NavId = (typeof nav)[number]['id'];
	const phoneTabs: NavId[] = ['home', 'chat', 'brief', 'history'];
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import { cn } from '$lib/utils';

	let {
		active,
		title,
		back,
		waiting = 0,
		actions,
		children
	}: {
		active: NavId;
		title: string;
		back?: { href: string; label: string };
		waiting?: number;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	const moreActive = $derived(!phoneTabs.includes(active));
</script>

<div class="@container h-full bg-background text-foreground">
	<div class="flex h-full flex-col @3xl:flex-row">
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
			{#each nav as item (item.id)}
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
					{/if}
				</a>
			{/each}
		</nav>

		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<header class="flex h-13 shrink-0 items-center gap-1 border-b px-2 @3xl:px-5">
				{#if back}
					<a
						href={back.href}
						class="-ml-0.5 flex h-9 items-center rounded-md pr-1.5 pl-0.5 text-sm text-muted-foreground hover:text-foreground"
					>
						<ChevronLeft class="size-5" aria-hidden="true" /><span class="sr-only @3xl:not-sr-only"
							>{back.label}</span
						>
					</a>
				{/if}
				<h1 class={cn('min-w-0 truncate text-base font-semibold', !back && 'pl-2 @3xl:pl-0')}>
					{title}
				</h1>
				<div class="ml-auto flex shrink-0 items-center gap-1">{@render actions?.()}</div>
			</header>

			<main class="@container min-h-0 flex-1 overflow-y-auto">
				{@render children()}
			</main>

			<nav aria-label="Main" class="grid shrink-0 grid-cols-5 border-t bg-background @3xl:hidden">
				{#each nav.filter((n) => phoneTabs.includes(n.id)) as item (item.id)}
					<a
						href={item.href}
						aria-current={active === item.id ? 'page' : undefined}
						class={cn(
							'relative flex h-15 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground',
							active === item.id && 'font-medium text-foreground'
						)}
					>
						<item.icon class="size-5" aria-hidden="true" />
						{item.label}
						{#if item.id === 'home' && waiting}
							<span
								class="absolute top-2 left-1/2 ml-1.5 min-w-4 rounded-full bg-waiting px-1 text-center text-[10px] leading-4 font-semibold text-background tabular-nums"
								>{waiting}</span
							>
						{/if}
					</a>
				{/each}
				<a
					href="/more"
					aria-current={moreActive ? 'page' : undefined}
					class={cn(
						'flex h-15 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground',
						moreActive && 'font-medium text-foreground'
					)}
				>
					<Ellipsis class="size-5" aria-hidden="true" />
					{moreActive ? nav.find((n) => n.id === active)?.label : 'More'}
				</a>
			</nav>
		</div>
	</div>
</div>
