<script lang="ts">
	import type { Snippet } from 'svelte';
	import { BitsConfig } from 'bits-ui';
	import { cn } from '$lib/utils';
	import { setDrawer } from './drawer';
	import type { NavItem } from './types';

	let {
		nav,
		active,
		home = 'chat',
		badges = {},
		onhome,
		children
	}: {
		/** The phone drawer and the desktop sidebar. */
		nav: NavItem[];
		active?: string;
		/** The entry back returns to: leaving any other entry from the drawer replaces it. */
		home?: string;
		/** A count for a pill, or true for an unread dot, by nav id. */
		badges?: Record<string, number | boolean | undefined>;
		/** Called on a click of the `home` entry, before it navigates; it may take over the click. */
		onhome?: (e: MouseEvent) => void;
		children: Snippet;
	} = $props();

	// Sheets portal in here rather than to <body>, so container queries and the prototype's phone
	// frames still apply to them.
	const uid = $props.id();
	const sheets = `${uid}-sheets`;
	let drawer = $state<HTMLDialogElement | null>(null);

	const badgeTotal = $derived.by(() => {
		const values = Object.values(badges);
		const count = values.reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0);
		return count || values.some((v) => v === true);
	});
	setDrawer({
		open: () => drawer?.showModal(),
		get badge() {
			return badgeTotal;
		}
	});

	// A navigation from anywhere, back included, leaves the drawer closed.
	$effect(() => {
		void active;
		drawer?.close();
	});

	// Wide enough for the sidebar, the drawer hides, and an open modal would leave the page inert.
	$effect(() => {
		const wide = matchMedia('(min-width: 48rem)');
		const close = () => wide.matches && drawer?.close();
		wide.addEventListener('change', close);
		return () => wide.removeEventListener('change', close);
	});
</script>

{#snippet badge(id: string)}
	{@const value = badges[id]}
	{#if typeof value === 'number' && value > 0}
		<span
			class="ml-auto rounded-full bg-waiting-soft px-1.5 text-xs font-semibold text-waiting tabular-nums"
			>{value}<span class="sr-only">{' need you'}</span></span
		>
	{:else if value === true}
		<span class="ml-auto size-2 rounded-full bg-brand"><span class="sr-only">Unread</span></span>
	{/if}
{/snippet}

{#snippet links(where: 'sidebar' | 'drawer')}
	{#each nav as item (item.id)}
		<a
			href={item.href}
			aria-current={active === item.id ? 'page' : undefined}
			data-sveltekit-replacestate={active && active !== home && item.id !== active ? '' : undefined}
			onclick={(e) => {
				drawer?.close();
				if (item.id === home && item.id !== active) onhome?.(e);
			}}
			class={cn(
				'flex h-12 shrink-0 items-center gap-3 rounded-md px-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
				where === 'sidebar' ? 'gap-2.5 text-sm' : 'text-base',
				item.sub && 'pl-8',
				active === item.id && 'bg-sidebar-accent font-medium text-foreground'
			)}
		>
			<item.icon class={where === 'sidebar' ? 'size-4' : 'size-5'} aria-hidden="true" />
			{item.label}
			{@render badge(item.id)}
		</a>
	{/each}
{/snippet}

{#snippet brand()}
	<div class="mb-4 flex items-center gap-2 px-2 pt-1">
		<span class="grid size-7 place-items-center rounded-md bg-foreground text-background">
			<svg viewBox="0 0 16 16" class="size-4" aria-hidden="true"
				><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2" /><circle
					cx="8"
					cy="8"
					r="1.6"
					fill="currentColor"
				/></svg
			>
		</span>
		<span class="text-sm font-semibold">Agent</span>
	</div>
{/snippet}

<div
	data-shell
	class="group/shell @container relative h-[calc(100%-var(--kb))] overflow-hidden bg-background pt-(--safe-top) text-foreground"
>
	<div class="flex h-full flex-col @3xl:flex-row">
		<nav
			aria-label="Main"
			class="hidden w-52 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-3 @3xl:flex"
		>
			{@render brand()}
			{@render links('sidebar')}
		</nav>

		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<BitsConfig defaultPortalTo={`#${sheets}`}>{@render children()}</BitsConfig>
		</div>
	</div>
	<div id={sheets}></div>
	<!-- A native modal dialog, so Android back and Escape close it before leaving the screen. -->
	<dialog
		bind:this={drawer}
		aria-label="Menu"
		onclick={(e) => e.target === drawer && drawer?.close()}
		class="drawer m-0 h-full max-h-none w-[min(20rem,85%)] max-w-none overflow-y-auto overscroll-contain border-r bg-sidebar p-0 text-foreground @3xl:hidden"
	>
		<nav
			aria-label="Main"
			class="flex min-h-full flex-col gap-0.5 px-3 pt-[calc(var(--safe-top)+0.75rem)] pb-[calc(var(--safe-bottom)+0.75rem)]"
		>
			{@render brand()}
			{@render links('drawer')}
		</nav>
	</dialog>
</div>

<style>
	.drawer::backdrop {
		background: color-mix(in oklab, var(--foreground) 35%, transparent);
	}
	@media (prefers-reduced-motion: no-preference) {
		.drawer[open] {
			animation: drawer-in 180ms ease-out;
		}
	}
	@keyframes drawer-in {
		from {
			transform: translateX(-100%);
		}
	}
</style>
