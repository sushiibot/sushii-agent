import type { Component } from 'svelte';

export interface NavItem {
	id: string;
	href: string;
	label: string;
	icon: Component<{ class?: string; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;
}
