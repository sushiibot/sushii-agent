import { ChatStore, type ChatStoreDeps } from './store.svelte';

let store: Promise<ChatStore> | null = null;

/** The one chat store for the app's lifetime, so leaving Main and coming back keeps the stream. */
export function chatStore(): Promise<ChatStore> {
	store ??= (async () => {
		let deps: ChatStoreDeps = {};
		if (import.meta.env.DEV && new URLSearchParams(location.search).has('fake')) {
			deps = (await import('./fake')).createFakeBackend();
		}
		const s = new ChatStore(deps);
		void s.start();
		return s;
	})();
	return store;
}
