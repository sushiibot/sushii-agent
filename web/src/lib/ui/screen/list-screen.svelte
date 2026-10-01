<script lang="ts" module>
	import type { Component } from 'svelte';

	export interface ListSection<I> {
		label?: string;
		/** Shown before the label. */
		icon?: Component<{ class?: string; 'aria-hidden'?: boolean | 'true' }>;
		/** Classes for the icon, such as a status tone. */
		iconClass?: string;
		/** Show how many items the section holds after its label. */
		count?: boolean;
		items: I[];
	}
</script>

<script lang="ts" generics="T">
	import type { ComponentProps, Snippet } from 'svelte';
	import Search from '@lucide/svelte/icons/search';
	import { Input } from '$lib/ui/input';
	import { cn } from '$lib/utils';
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
		searchInput = $bindable(null),
		lead,
		after,
		isEmpty: emptyOverride,
		key,
		row
	}: Omit<ScreenProps, 'children' | 'stickToBottom' | 'scroller'> & {
		state: Omit<StateProps, 'children' | 'isEmpty'>;
		sections: ListSection<T>[];
		/** Shows a search field when bound. */
		search?: string;
		searchLabel?: string;
		searchInput?: HTMLInputElement | null;
		/** Above the list, whatever its state. */
		lead?: Snippet;
		/** Under the sections once loaded, such as a "load older" button or a note. */
		after?: Snippet;
		/** Overrides "every section is empty", for lists with more to show than their rows. */
		isEmpty?: boolean;
		key: (item: T) => string;
		row: Snippet<[T]>;
	} = $props();

	const uid = $props.id();
	const isEmpty = $derived(emptyOverride ?? sections.every((s) => s.items.length === 0));
</script>

<Screen {title} {subtitle} {back} {actions} {banner} {toast} {footer}>
	<div class="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-4 pb-10">
		{#if search !== undefined}
			<label class="relative block">
				<span class="sr-only">{searchLabel}</span>
				<Search
					class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					type="search"
					bind:value={search}
					bind:ref={searchInput}
					placeholder={searchLabel}
					class="h-12 pl-9 text-base"
				/>
			</label>
		{/if}
		{@render lead?.()}
		<ScreenState {...state} {isEmpty}>
			{#each sections as section, i (section.label ?? i)}
				{#if section.items.length}
					<section
						class="flex flex-col gap-1"
						aria-labelledby={section.label ? `${uid}-s${i}` : undefined}
					>
						{#if section.label}
							<h2
								id="{uid}-s{i}"
								class="flex items-center gap-2 px-1 text-sm font-medium text-muted-foreground"
							>
								{#if section.icon}
									<section.icon
										class={cn('size-4 shrink-0', section.iconClass)}
										aria-hidden="true"
									/>
								{/if}
								{section.label}
								{#if section.count}<span class="tabular-nums">{section.items.length}</span>{/if}
							</h2>
						{/if}
						<ul class="flex flex-col">
							{#each section.items as item (key(item))}
								<li class="min-h-12">{@render row(item)}</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/each}
			{@render after?.()}
		</ScreenState>
	</div>
</Screen>
