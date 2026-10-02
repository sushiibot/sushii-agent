<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import Menu from '@lucide/svelte/icons/menu';
	import { cn } from '$lib/utils';
	import { getDrawer } from '../shell/drawer';

	let {
		title,
		subtitle,
		back,
		actions,
		banner,
		toast,
		footer,
		stickToBottom = false,
		scrollable = true,
		scroller = $bindable(null),
		children
	}: {
		title: string;
		subtitle?: Snippet;
		/** `desktop: false` hides it where the sidebar already leads there. */
		back?: { href: string; label: string; onclick?: (e: MouseEvent) => void; desktop?: boolean };
		actions?: Snippet;
		/** Under the header, outside the scroll. */
		banner?: Snippet;
		/** A transient line above the footer. */
		toast?: Snippet;
		footer?: Snippet;
		/** Disable when the content owns its vertical scroll, such as a tab pager. */
		scrollable?: boolean;
		/** Keep the newest content in view, for chats. */
		stickToBottom?: boolean;
		/** The scrolling region, for callers that track the reader's position. */
		scroller?: HTMLElement | null;
		children: Snippet;
	} = $props();

	// A screen without a back chevron is a drawer destination; on a phone its header opens the drawer.
	const drawer = getDrawer();
</script>

<header class="flex min-h-13 shrink-0 items-center gap-1 border-b px-2 py-1 @3xl:px-5">
	{#if back}
		<a
			href={back.href}
			onclick={back.onclick}
			class={cn(
				'-ml-0.5 flex h-12 min-w-12 shrink-0 items-center rounded-md pr-1.5 pl-0.5 text-sm text-muted-foreground hover:text-foreground',
				back.desktop === false && '@3xl:hidden'
			)}
		>
			<ChevronLeft class="size-5" aria-hidden="true" /><span class="sr-only @3xl:not-sr-only"
				>{back.label}</span
			>
		</a>
	{:else if drawer}
		<button
			type="button"
			aria-label={drawer.badge
				? `Menu, ${typeof drawer.badge === 'number' ? `${drawer.badge} need you` : 'something new'}`
				: 'Menu'}
			onclick={() => drawer.open()}
			class="relative grid size-12 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground @3xl:hidden"
		>
			<Menu class="size-5" aria-hidden="true" />
			{#if drawer.badge}
				<span
					class="absolute top-2.5 right-2.5 size-2.5 rounded-full border-2 border-background bg-waiting"
					aria-hidden="true"
				></span>
			{/if}
		</button>
	{/if}
	<div
		class={cn(
			'flex min-w-0 flex-col',
			!back && !drawer && 'pl-2 @3xl:pl-0',
			!back && drawer && '@3xl:pl-0'
		)}
	>
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
		'@container min-h-0 flex-1 overflow-x-clip overscroll-contain',
		scrollable ? 'overflow-y-auto' : 'overflow-y-hidden',
		stickToBottom && 'flex flex-col-reverse'
	)}
>
	<div class={stickToBottom ? 'shrink-0' : 'h-full'}>{@render children()}</div>
</main>

<div class="relative shrink-0 bg-background pb-(--safe-bottom) @3xl:pb-0 kb:pb-0">
	{#if toast}
		<div
			role="status"
			class="absolute inset-x-3 bottom-full mb-3 flex items-center gap-3 rounded-xl bg-foreground px-4 py-3 text-sm [overflow-wrap:anywhere] text-background shadow-lg @3xl:right-auto @3xl:left-6 @3xl:w-96"
		>
			{@render toast()}
		</div>
	{/if}
	{@render footer?.()}
</div>
