import type { Component } from 'svelte';

export interface NavItem {
	id: string;
	href: string;
	label: string;
	icon: Component<{ class?: string; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;
	/** Listed under the entry above it in the sidebar. */
	sub?: boolean;
	/** What is behind it, in one line, where a list has room for it. */
	description?: string;
}
