<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
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
		swipe,
		state,
		children
	}: Omit<ScreenProps, 'back' | 'children' | 'stickToBottom' | 'scroller'> & {
		back?: ScreenProps['back'];
		/** Leave out for a screen whose content is always there. */
		state?: Omit<StateProps, 'children'>;
		children: Snippet;
	} = $props();
</script>

<Screen {title} {subtitle} {back} {actions} {banner} {toast} {footer} {swipe}>
	{#if state}
		<ScreenState {...state}>{@render children()}</ScreenState>
	{:else}
		{@render children()}
	{/if}
</Screen>
