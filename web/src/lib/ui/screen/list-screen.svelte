<script lang="ts" generics="T">
	import type { ComponentProps, Snippet } from 'svelte';
	import Search from '@lucide/svelte/icons/search';
	import { Input } from '$lib/ui/input';
	import Screen from './screen.svelte';
	import ScreenState from './screen-state.svelte';

	type ScreenProps = ComponentProps<typeof Screen>;
	type StateProps = ComponentProps<typeof ScreenState>;

	let {
		title,
		subtitle,
		back,
		actions,
		banner,
		toast,
		footer,
		state,
		sections,
		search = $bindable(),
		searchLabel = 'Search',
		key,
		row
	}: Omit<ScreenProps, 'children' | 'stickToBottom' | 'scroller'> & {
		state: Omit<StateProps, 'children' | 'isEmpty'>;
		sections: { label?: string; items: T[] }[];
		/** Shows a search field when bound. */
		search?: string;
		searchLabel?: string;
		key: (item: T) => string;
		row: Snippet<[T]>;
	} = $props();

	const isEmpty = $derived(sections.every((s) => s.items.length === 0));
</script>

<Screen {title} {subtitle} {back} {actions} {banner} {toast} {footer}>
	<div class="mx-auto flex max-w-2xl flex-col gap-4 px-4 pt-4 pb-10">
		{#if search !== undefined}
			<label class="relative block">
				<span class="sr-only">{searchLabel}</span>
				<Search
					class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input type="search" bind:value={search} placeholder={searchLabel} class="h-12 pl-9" />
			</label>
		{/if}
		<ScreenState {...state} {isEmpty}>
			{#each sections as section, i (section.label ?? i)}
				{#if section.items.length}
					<section class="flex flex-col gap-1">
						{#if section.label}
							<h2 class="px-1 text-sm font-medium text-muted-foreground">{section.label}</h2>
						{/if}
						<ul class="flex flex-col">
							{#each section.items as item (key(item))}
								<li class="min-h-12">{@render row(item)}</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/each}
		</ScreenState>
	</div>
</Screen>
