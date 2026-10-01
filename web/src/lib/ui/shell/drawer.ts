import { getContext, setContext } from 'svelte';

const KEY = Symbol('drawer');

/** What a screen header needs to show the phone menu button. */
export interface DrawerHandle {
	open(): void;
	/** Something in the drawer wants attention: a count, or true for a dot. */
	readonly badge: number | boolean;
}

export function setDrawer(handle: DrawerHandle) {
	setContext(KEY, handle);
}

/** Undefined outside a shell, such as the prototype's bare frames. */
export function getDrawer(): DrawerHandle | undefined {
	return getContext<DrawerHandle | undefined>(KEY);
}
