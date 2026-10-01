import { redirect } from '@sveltejs/kit';

// Pushes for Home items link to /home?item=; Home itself lives at /.
export function load({ url }) {
	const item = url.searchParams.get('item');
	redirect(307, item ? `/?item=${encodeURIComponent(item)}` : '/');
}
