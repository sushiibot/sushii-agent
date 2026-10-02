import { api } from './api';
import { WEB_FEATURES, type WebFeature } from './realtime/events';

/** Fixture-only screens; live screens are always available. */
export const CLIENT_FEATURES = ['skills', 'schedules', 'browser', 'briefing'] as const;
export type ClientFeature = (typeof CLIENT_FEATURES)[number];
export type AppFeature = WebFeature | ClientFeature;
export const ALL_FEATURES: readonly AppFeature[] = [...WEB_FEATURES, ...CLIENT_FEATURES];

/** Device previews for screens that do not yet have a backend. */
export const OVERRIDE_KEY = 'features:override';

export function parseOverride(raw: string | null): ReadonlySet<ClientFeature> {
	if (!raw?.trim()) return new Set();
	if (raw.trim() === 'all') return new Set(CLIENT_FEATURES);
	const known = new Set<string>(CLIENT_FEATURES);
	return new Set(
		raw
			.split(',')
			.map((s) => s.trim())
			.filter((f): f is ClientFeature => known.has(f))
	);
}

function storedOverride(): ReadonlySet<ClientFeature> {
	try {
		return parseOverride(localStorage.getItem(OVERRIDE_KEY));
	} catch {
		return new Set();
	}
}

/** Dictation capability and local previews; live routes never depend on /api/me. */
export class Features {
	fresh = $state(false);
	override = $state.raw<ReadonlySet<ClientFeature>>(new Set());
	/** The bot can turn speech into text (POST /api/dictation). */
	dictation = $state(false);

	#load: () => Promise<{ dictation?: boolean }>;
	#inflight: Promise<void> | null = null;

	constructor(load: () => Promise<{ dictation?: boolean }> = api.me, override = storedOverride()) {
		this.#load = load;
		this.override = override;
	}

	/** Fixture previews enabled on this device. */
	has = (f: ClientFeature | undefined): boolean => !f || this.override.has(f);

	/** Turns fixture screens on for this device; `null` clears it. */
	setOverride(value: 'all' | ClientFeature[] | null) {
		const raw = value === null ? null : value === 'all' ? 'all' : value.join(',');
		try {
			if (raw === null) localStorage.removeItem(OVERRIDE_KEY);
			else localStorage.setItem(OVERRIDE_KEY, raw);
		} catch {
			// Private mode: on for this page view only.
		}
		this.override = parseOverride(raw);
	}

	/** Asks the bot once per visit; a failure is retried on the next call. */
	load(): Promise<void> {
		if (this.fresh) return Promise.resolve();
		return (this.#inflight ??= this.#load()
			.then((me) => {
				this.dictation = me.dictation === true;
				this.fresh = true;
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
