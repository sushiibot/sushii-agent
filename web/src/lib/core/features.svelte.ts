import { api } from './api';
import { WEB_FEATURES, type WebFeature } from './realtime/events';

const KEY = 'web-features';

function cached(): WebFeature[] | null {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		return Array.isArray(raw)
			? raw.filter((f): f is WebFeature => (WEB_FEATURES as readonly unknown[]).includes(f))
			: null;
	} catch {
		return null;
	}
}

function remember(list: readonly WebFeature[]) {
	try {
		localStorage.setItem(KEY, JSON.stringify(list));
	} catch {
		// Only a faster first paint next time.
	}
}

/** The slices the bot has turned on (`GET /api/me` `features`). */
export class Features {
	/** null until known; an earlier visit's answer stands in until this visit's arrives. */
	list = $state.raw<readonly WebFeature[] | null>(null);
	/** This visit's /api/me has answered. */
	fresh = $state(false);

	#load: () => Promise<{ features?: WebFeature[] }>;
	#inflight: Promise<void> | null = null;

	constructor(load: () => Promise<{ features?: WebFeature[] }> = api.me, initial = cached()) {
		this.#load = load;
		this.list = initial;
	}

	/** Shown in the nav: on as far as anything says. */
	has(f: WebFeature): boolean {
		return this.list?.includes(f) ?? false;
	}

	/** Known to be off right now, so its screens send you Home. Unknown is never off. */
	off(f: WebFeature): boolean {
		return this.fresh && !this.has(f);
	}

	/** Asks the bot once per visit; a failure is retried on the next call. */
	load(): Promise<void> {
		if (this.fresh) return Promise.resolve();
		return (this.#inflight ??= this.#load()
			.then((me) => {
				const list = WEB_FEATURES.filter((f) => me.features?.includes(f));
				this.list = list;
				this.fresh = true;
				remember(list);
			})
			.catch(() => {
				// Keep what we had; offline or not signed in yet.
			})
			.finally(() => {
				this.#inflight = null;
			}));
	}

	/** Loads now and again whenever the app comes back online or into view, until it has an answer. */
	start(): () => void {
		void this.load();
		const retry = () => {
			if (document.visibilityState === 'visible') void this.load();
		};
		addEventListener('online', retry);
		document.addEventListener('visibilitychange', retry);
		return () => {
			removeEventListener('online', retry);
			document.removeEventListener('visibilitychange', retry);
		};
	}
}

export const features = new Features();
