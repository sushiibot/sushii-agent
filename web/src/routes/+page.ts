import { redirect } from '@sveltejs/kit';

const INBOX_PARAMS = ['approve', 'ask', 'item'];

// The app opens on the chat; links from before the inbox moved keep their item.
export function load({ url }) {
	const key = INBOX_PARAMS.find((k) => url.searchParams.has(k));
	if (!key) redirect(307, '/chat');
	redirect(307, `/inbox?${key}=${encodeURIComponent(url.searchParams.get(key)!)}`);
}
