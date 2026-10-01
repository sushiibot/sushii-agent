import { redirect } from '@sveltejs/kit';

// Pushes from before the inbox moved link to /home?item=.
export function load({ url }) {
	const item = url.searchParams.get('item');
	redirect(307, item ? `/inbox?item=${encodeURIComponent(item)}` : '/inbox');
}
