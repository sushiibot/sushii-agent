import Activity from '@lucide/svelte/icons/activity';
import BookMarked from '@lucide/svelte/icons/book-marked';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import History from '@lucide/svelte/icons/history';
import House from '@lucide/svelte/icons/house';
import MessagesSquare from '@lucide/svelte/icons/messages-square';
import Plug from '@lucide/svelte/icons/plug';
import Sunrise from '@lucide/svelte/icons/sunrise';
import type { NavItem } from '$lib/ui/shell/types';

/** The desktop sidebar, top to bottom. */
export const nav: NavItem[] = [
	{ id: 'home', href: '/', label: 'Home', icon: House },
	{ id: 'chats', href: '/chats', label: 'Chats', icon: MessagesSquare },
	{ id: 'brief', href: '/brief', label: 'Briefing', icon: Sunrise },
	{ id: 'runs', href: '/runs', label: 'Runs', icon: Activity },
	{ id: 'memory', href: '/memory', label: 'Memory & skills', icon: BookMarked },
	{ id: 'schedules', href: '/schedules', label: 'Schedules', icon: CalendarClock },
	{ id: 'connectors', href: '/connectors', label: 'Connectors', icon: Plug },
	{ id: 'history', href: '/history', label: 'History', icon: History }
];

/** The phone tab bar, left to right. */
export const tabs: NavItem[] = [
	...nav.filter((n) => ['home', 'chats', 'brief'].includes(n.id)),
	{ id: 'more', href: '/more', label: 'More', icon: Ellipsis }
];

/** The nav entry a route belongs to. */
export function activeTab(routeId: string | null): string {
	return routeId === '/' ? 'home' : 'more';
}
