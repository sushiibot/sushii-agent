import { redirect } from '@sveltejs/kit';

// More was the tab bar's overflow; its entries are in the drawer now.
export function load() {
	redirect(307, '/chat');
}
