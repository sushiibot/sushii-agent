import { Remote } from '$lib/core/remote.svelte';
import type { MemoryApi } from './api';
import { createFixtureMemoryApi } from './fake';
import type { MemoryFileDetail, MemoryOverview, MemoryWriteRecord } from './types';

export class MemoryStore {
	overview: Remote<MemoryOverview>;
	busy = $state(false);
	/** The last revert or restore, for the toast: what happened and whether it worked. */
	result = $state<{ id: string; kind: 'reverted' | 'restored' | 'failed'; text: string } | null>(
		null
	);

	#api: MemoryApi;
	#files = new Map<string, Remote<MemoryFileDetail | null>>();
	#writes = new Map<string, Remote<MemoryWriteRecord | null>>();

	constructor(api: MemoryApi = createFixtureMemoryApi()) {
		this.#api = api;
		this.overview = new Remote(() => api.overview(), { refetchOnFocus: true });
	}

	file(id: string) {
		let r = this.#files.get(id);
		if (!r) this.#files.set(id, (r = new Remote(() => this.#api.file(id))));
		return r;
	}

	write(id: string) {
		let r = this.#writes.get(id);
		if (!r) this.#writes.set(id, (r = new Remote(() => this.#api.write(id))));
		return r;
	}

	async #change(id: string, kind: 'reverted' | 'restored') {
		this.busy = true;
		try {
			const next = await (kind === 'reverted' ? this.#api.revert(id) : this.#api.restore(id));
			this.write(id).data = next;
			this.result = {
				id,
				kind,
				text:
					kind === 'reverted'
						? 'Change reverted. The agent stops seeing it from its next turn.'
						: 'Change restored.'
			};
			void this.overview.refetch();
			void this.file(next.fileId).refetch();
		} catch (err) {
			this.result = {
				id,
				kind: 'failed',
				text: `Couldn't ${kind === 'reverted' ? 'revert' : 'restore'} it. ${err instanceof Error ? err.message : ''}`.trim()
			};
		} finally {
			this.busy = false;
		}
	}

	revert = (id: string) => this.#change(id, 'reverted');
	restore = (id: string) => this.#change(id, 'restored');
	clearResult() {
		this.result = null;
	}
}

let store: MemoryStore | null = null;
let configured: MemoryApi | undefined;

export function configureMemory(api: MemoryApi) {
	configured = api;
}

export function memoryStore(): MemoryStore {
	return (store ??= new MemoryStore(configured));
}
