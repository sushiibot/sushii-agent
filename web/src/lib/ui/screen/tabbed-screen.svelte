<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Screen from './screen.svelte';
	import ScreenState from './screen-state.svelte';
	import SwipeableTabs, { type SwipeableTab } from '../tabs/swipeable-tabs.svelte';

	type ScreenProps = ComponentProps<typeof Screen>;
	type StateProps = Omit<ComponentProps<typeof ScreenState>, 'children'>;

	let {
		title,
		subtitle,
		back,
		actions,
		banner,
		toast,
		tabs,
		value = $bindable(''),
		label,
		onchange,
		lead: leadContent,
		wide = false,
		state,
		hasContent = false,
		children: panelContent
	}: Pick<ScreenProps, 'title' | 'subtitle' | 'back' | 'actions' | 'banner' | 'toast'> & {
		tabs: readonly SwipeableTab[];
		value?: string;
		label: string;
		onchange?: (value: string) => void;
		lead?: Snippet;
		/** Use the wider desktop measure for detailed content. */
		wide?: boolean;
		state?: StateProps;
		/** Keep the pager mounted while existing content refreshes. */
		hasContent?: boolean;
		children: Snippet<[value: string]>;
	} = $props();

	const effectiveState = $derived(
		state && hasContent && state.remote.status === 'loading'
			? { ...state, remote: { status: 'ready' as const } }
			: state
	);
	const showPager = $derived(
		!effectiveState ||
			(effectiveState.remote.status === 'ready' &&
				!(effectiveState.isEmpty && effectiveState.empty))
	);
</script>

<Screen {title} {subtitle} {back} {actions} {banner} {toast} scrollable={false}>
	<div
		data-tabbed-screen
		class="mx-auto flex h-full min-h-0 w-full min-w-0 flex-col {wide ? 'max-w-3xl' : 'max-w-2xl'}"
	>
		{#if showPager}
			<SwipeableTabs {tabs} bind:value {label} {onchange}>
				{#snippet lead()}
					{#if leadContent}
						<div class="px-4 pt-4 pb-3">{@render leadContent()}</div>
					{/if}
				{/snippet}
				{#snippet children(panelValue)}
					<div data-tab-content class="min-w-0 px-4 pt-4 pb-12">
						{@render panelContent(panelValue)}
					</div>
				{/snippet}
			</SwipeableTabs>
		{:else if effectiveState}
			<div
				class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-4 pb-12"
			>
				<ScreenState {...effectiveState}>{#snippet children()}{/snippet}</ScreenState>
			</div>
		{/if}
	</div>
</Screen>
