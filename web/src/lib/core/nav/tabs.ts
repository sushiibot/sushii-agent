import Activity from '@lucide/svelte/icons/activity';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import History from '@lucide/svelte/icons/history';
import House from '@lucide/svelte/icons/house';
import MessageSquare from '@lucide/svelte/icons/message-square';
import Settings from '@lucide/svelte/icons/settings';
import type { NavItem } from '$lib/ui/shell/types';

/** The phone tab bar, left to right. */
export const tabs: NavItem[] = [
	{ id: 'home', href: '/', label: 'Home', icon: House },
	{ id: 'chat', href: '/chat', label: 'Chat', icon: MessageSquare },
	{ id: 'more', href: '/more', label: 'More', icon: Ellipsis }
];

/** The More screen, top to bottom. */
export const more: NavItem[] = [
	{
		id: 'runs',
		href: '/runs',
		label: 'Runs',
		icon: Activity,
		description: 'Every chat turn, scheduled job and background run'
	},
	{
		id: 'history',
		href: '/history',
		label: 'History',
		icon: History,
		description: "The agent's notes by day, and search across chat and notes"
	},
	{
		id: 'settings',
		href: '/settings',
		label: 'Settings',
		icon: Settings,
		description: 'Notifications, theme and this device'
	}
];

/** The desktop sidebar, top to bottom: the tabs, with More's main entries under it. */
export const nav: NavItem[] = [
	...tabs,
	...more.filter((m) => m.id !== 'settings').map((m) => ({ ...m, sub: true }))
];

/** The nav entry a route belongs to; the tab bar lights its tab, the sidebar its row. */
export function activeTab(routeId: string | null): string | undefined {
	if (!routeId) return undefined;
	const path = routeId.replace(/\/\([^)]+\)/g, '') || '/';
	if (path === '/') return 'home';
	if (path === '/chat') return 'chat';
	if (path.startsWith('/runs')) return 'runs';
	if (path.startsWith('/history')) return 'history';
	return 'more';
}

/** Routes in the `(tabs)` group show the tab bar; Chat and detail screens hide it. */
export function showsTabBar(routeId: string | null): boolean {
	return !!routeId?.startsWith('/(tabs)');
}
