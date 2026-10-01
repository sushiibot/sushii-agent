import { Remote } from '$lib/core/remote.svelte';
import { createFixtureBrowserApi, type BrowserApi } from './fake';
import type { BrowserPending } from './types';

export class BrowserStore {
	status: Remote<import('./types').BrowserStatus>;
	pending = $state<BrowserPending>(null);
	error = $state<string | null>(null);
	#api: BrowserApi;

	constructor(api: BrowserApi = createFixtureBrowserApi()) {
		this.#api = api;
		this.status = new Remote(() => api.status(), { refetchOnFocus: true });
	}

	async #swap(kind: 'taking' | 'handing') {
		this.pending = kind;
		this.error = null;
		try {
			this.status.data = await (kind === 'taking' ? this.#api.takeOver() : this.#api.handBack());
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			this.pending = null;
		}
	}

	takeOver = () => this.#swap('taking');
	handBack = () => this.#swap('handing');
}

let store: BrowserStore | null = null;

export function browserStore(): BrowserStore {
	return (store ??= new BrowserStore());
}
