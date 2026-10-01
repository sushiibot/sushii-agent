<script lang="ts">
	import type { Snippet } from 'svelte';
	import { BitsConfig } from 'bits-ui';
	import { cn } from '$lib/utils';
	import type { NavItem } from './types';

	let {
		nav,
		tabs,
		active,
		tabBar = true,
		badges = {},
		children
	}: {
		/** The desktop sidebar. */
		nav: NavItem[];
		/** The phone tab bar. */
		tabs: NavItem[];
		active?: string;
		tabBar?: boolean;
		/** A count for a pill, or true for an unread dot, by nav id. */
		badges?: Record<string, number | boolean | undefined>;
		children: Snippet;
	} = $props();

	// Sheets portal in here rather than to <body>, so container queries and the prototype's phone
	// frames still apply to them.
	const uid = $props.id();
	const sheets = `${uid}-sheets`;
</script>

{#snippet badge(id: string, where: 'sidebar' | 'tab')}
	{@const value = badges[id]}
	{#if typeof value === 'number' && value > 0}
		{#if where === 'sidebar'}
			<span
				class="ml-auto rounded-full bg-waiting-soft px-1.5 text-xs font-semibold text-waiting tabular-nums"
				>{value}</span
			>
		{:else}
			<span
				class="absolute top-1.5 left-1/2 ml-1.5 min-w-4 rounded-full bg-waiting px-1 text-center text-tab leading-4 font-semibold text-background tabular-nums"
				>{value}<span class="sr-only">{' waiting'}</span></span
			>
		{/if}
	{:else if value === true}
		<span
			class={cn(
				'size-2 rounded-full bg-brand',
				where === 'sidebar' ? 'ml-auto' : 'absolute top-2 left-1/2 ml-2'
			)}><span class="sr-only">Unread</span></span
		>
	{/if}
{/snippet}

<div
	data-shell
	data-tabbar={tabBar || undefined}
	class="group/shell @container relative h-[calc(100%-var(--kb))] overflow-hidden bg-background pt-(--safe-top) text-foreground"
>
	<div class="flex h-full flex-col @3xl:flex-row">
		<nav
			aria-label="Main"
			class="hidden w-52 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-3 @3xl:flex"
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
						'flex h-12 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
						item.sub && 'pl-8',
						active === item.id && 'bg-sidebar-accent font-medium text-foreground'
					)}
				>
					<item.icon class="size-4" aria-hidden="true" />
					{item.label}
					{@render badge(item.id, 'sidebar')}
				</a>
			{/each}
		</nav>

		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<BitsConfig defaultPortalTo={`#${sheets}`}>{@render children()}</BitsConfig>
			{#if tabBar}
				<nav
					aria-label="Main"
					class="grid shrink-0 border-t bg-background pb-(--safe-bottom) select-none [-webkit-touch-callout:none] @3xl:hidden kb:hidden"
					style:grid-template-columns="repeat({tabs.length}, minmax(0, 1fr))"
				>
					{#each tabs as item (item.id)}
						{@const current = active === item.id}
						<!-- From any tab but the first, switching replaces the entry, so back always lands on Home. -->
						<a
							href={item.href}
							aria-current={current ? 'page' : undefined}
							data-sveltekit-replacestate={active && active !== tabs[0]?.id ? '' : undefined}
							class={cn(
								'relative flex h-14 flex-col items-center justify-center gap-1 text-tab text-muted-foreground',
								current && 'font-semibold text-foreground'
							)}
						>
							<item.icon class="size-5" aria-hidden="true" strokeWidth={current ? 2.25 : 1.75} />
							{item.label}
							{@render badge(item.id, 'tab')}
						</a>
					{/each}
				</nav>
			{/if}
		</div>
	</div>
	<div id={sheets}></div>
</div>
