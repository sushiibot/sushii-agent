import Activity from '@lucide/svelte/icons/activity';
import BookMarked from '@lucide/svelte/icons/book-marked';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import Globe from '@lucide/svelte/icons/globe';
import History from '@lucide/svelte/icons/history';
import House from '@lucide/svelte/icons/house';
import MessageSquare from '@lucide/svelte/icons/message-square';
import MessagesSquare from '@lucide/svelte/icons/messages-square';
import Plug from '@lucide/svelte/icons/plug';
import Settings from '@lucide/svelte/icons/settings';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Sunrise from '@lucide/svelte/icons/sunrise';
import type { NavItem } from '$lib/ui/shell/types';
import type { AppFeature } from '../features.svelte';

/** A nav entry that shows only while its slice of the app is on. */
export interface NavEntry extends NavItem {
	feature?: AppFeature;
}

/** Which features are on; the prototype passes `allOn`. */
export type FeatureCheck = (feature: AppFeature | undefined) => boolean;
export const allOn: FeatureCheck = () => true;

const home: NavEntry = { id: 'home', href: '/', label: 'Home', icon: House };
const chat: NavEntry = { id: 'chat', href: '/chat', label: 'Chat', icon: MessageSquare };
const chats: NavEntry = { id: 'chat', href: '/chats', label: 'Chats', icon: MessagesSquare };
const moreTab: NavEntry = { id: 'more', href: '/more', label: 'More', icon: Ellipsis };

/** The More screen, top to bottom. */
const moreEntries: NavEntry[] = [
	{
		id: 'briefing',
		href: '/briefing',
		label: 'Briefing',
		icon: Sunrise,
		feature: 'briefing',
		description: "This morning's briefing, with sources"
	},
	{
		id: 'runs',
		href: '/runs',
		label: 'Runs',
		icon: Activity,
		feature: 'runs',
		description: 'Every chat turn, scheduled job and background run'
	},
	{
		id: 'history',
		href: '/history',
		label: 'History',
		icon: History,
		feature: 'history',
		description: "The agent's notes by day, and search across chat and notes"
	},
	{
		id: 'memory',
		href: '/memory',
		label: 'Memory',
		icon: BookMarked,
		feature: 'memory',
		description: 'What the agent remembers, and every change to it'
	},
	{
		id: 'skills',
		href: '/skills',
		label: 'Skills',
		icon: Sparkles,
		feature: 'skills',
		description: 'How-tos the agent wrote for itself, and their versions'
	},
	{
		id: 'schedules',
		href: '/schedules',
		label: 'Schedules',
		icon: CalendarClock,
		feature: 'schedules',
		description: 'Jobs that run on their own, and how each run went'
	},
	{
		id: 'connectors',
		href: '/connectors',
		label: 'Connectors',
		icon: Plug,
		feature: 'connectors',
		description: 'MCP servers and the tools they give the agent'
	},
	{
		id: 'browser',
		href: '/browser',
		label: 'Browser',
		icon: Globe,
		feature: 'browser',
		description: "Watch the agent's browser, or take it over to sign in"
	},
	{
		id: 'settings',
		href: '/settings',
		label: 'Settings',
		icon: Settings,
		description: 'Notifications, theme and this device'
	}
];

/** The phone tab bar, left to right. Chat becomes the Chats list once threads exist. */
export function tabsFor(on: FeatureCheck): NavEntry[] {
	return [home, on('threads') ? chats : chat, moreTab];
}

/** The More screen's entries that are on. */
export function moreFor(on: FeatureCheck): NavEntry[] {
	return moreEntries.filter((e) => on(e.feature));
}

/** The desktop sidebar, top to bottom: the tabs, with More's entries under it. */
export function navFor(on: FeatureCheck): NavEntry[] {
	return [
		...tabsFor(on),
		...moreFor(on)
			.filter((m) => m.id !== 'settings')
			.map((m) => ({ ...m, sub: true }))
	];
}

const pathOf = (routeId: string) => routeId.replace(/\/\([^)]+\)/g, '') || '/';
const sectionOf = (path: string) => path.match(/^\/[^/]+/)?.[0];

/** The nav entry a route belongs to; the tab bar lights its tab, the sidebar its row. */
export function activeTab(routeId: string | null): string | undefined {
	if (!routeId) return undefined;
	const path = pathOf(routeId);
	if (path === '/') return 'home';
	if (path === '/chat' || path.startsWith('/chats')) return 'chat';
	const section = sectionOf(path);
	return moreEntries.find((e) => e.href === section && e.id !== 'settings')?.id ?? 'more';
}

/** The feature a route needs, if any; with it off, the route sends you Home. */
export function featureOf(routeId: string | null): AppFeature | undefined {
	if (!routeId) return undefined;
	const path = pathOf(routeId);
	if (path.startsWith('/chats')) return 'threads';
	const section = sectionOf(path);
	return moreEntries.find((e) => e.href === section)?.feature;
}

/** Routes in the `(tabs)` group show the tab bar; Chat and detail screens hide it. */
export function showsTabBar(routeId: string | null): boolean {
	return !!routeId?.startsWith('/(tabs)');
}
