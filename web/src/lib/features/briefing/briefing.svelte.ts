import { Remote } from '$lib/core/remote.svelte';
import type { BriefingApi } from './api';
import { createFixtureBriefingApi } from './fake';
import type { BriefItem, BriefVote, Briefing } from './types';

export class BriefingStore {
	today: Remote<Briefing | null>;
	/** Set when saving a vote or dismissal failed; the item shows it as it was. */
	error = $state<string | null>(null);
	#api: BriefingApi;

	constructor(api: BriefingApi = createFixtureBriefingApi()) {
		this.#api = api;
		this.today = new Remote(() => api.today(), { refetchOnFocus: true });
	}

	#patch(id: string, change: Partial<BriefItem>) {
		const b = this.today.data;
		if (!b) return;
		this.today.data = {
			...b,
			items: b.items.map((i) => (i.id === id ? { ...i, ...change } : i))
		};
	}

	async #save(id: string, change: Partial<BriefItem>, send: () => Promise<void>) {
		const before = this.today.data?.items.find((i) => i.id === id);
		this.error = null;
		this.#patch(id, change);
		try {
			await send();
		} catch {
			if (before) this.#patch(id, before);
			this.error = "Couldn't save that. Check your connection and try again.";
		}
	}

	vote(id: string, vote: BriefVote) {
		const current = this.today.data?.items.find((i) => i.id === id)?.vote;
		const next = current === vote ? null : vote;
		return this.#save(id, { vote: next ?? undefined }, () => this.#api.vote(id, next));
	}

	dismiss(id: string, dismissed = true) {
		return this.#save(id, { dismissed }, () => this.#api.dismiss(id, dismissed));
	}
}

let store: BriefingStore | null = null;
let configured: BriefingApi | undefined;

export function configureBriefing(api: BriefingApi) {
	configured = api;
}

export function briefingStore(): BriefingStore {
	return (store ??= new BriefingStore(configured));
}
