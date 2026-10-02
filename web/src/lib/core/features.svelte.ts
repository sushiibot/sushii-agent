import { api } from './api';
import { WEB_FEATURES, type WebFeature } from './realtime/events';

/**
 * Screens that have no backend yet. The bot never lists them in /api/me, so they show only
 * through the device override; a backend adds its id to WEB_FEATURES when it ships.
 */
export const CLIENT_FEATURES = [
	'memory',
	'skills',
	'schedules',
	'browser',
	'briefing',
	'connectors'
] as const;
export type ClientFeature = (typeof CLIENT_FEATURES)[number];
export type AppFeature = WebFeature | ClientFeature;
export const ALL_FEATURES: readonly AppFeature[] = [...WEB_FEATURES, ...CLIENT_FEATURES];

const KEY = 'web-features';
/** `all`, or a comma list of feature ids, turned on on this device whatever the bot says. */
export const OVERRIDE_KEY = 'features:override';

const isWeb = (f: string): f is WebFeature => (WEB_FEATURES as readonly string[]).includes(f);

function cached(): WebFeature[] | null {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		return Array.isArray(raw) ? raw.filter((f): f is WebFeature => isWeb(f)) : null;
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

export function parseOverride(raw: string | null): ReadonlySet<AppFeature> {
	if (!raw?.trim()) return new Set();
	if (raw.trim() === 'all') return new Set(ALL_FEATURES);
	const known = new Set<string>(ALL_FEATURES);
	return new Set(
		raw
			.split(',')
			.map((s) => s.trim())
			.filter((f): f is AppFeature => known.has(f))
	);
}

function storedOverride(): ReadonlySet<AppFeature> {
	try {
		return parseOverride(localStorage.getItem(OVERRIDE_KEY));
	} catch {
		return new Set();
	}
}

/** The slices that are on: what the bot lists in `GET /api/me`, plus this device's override. */
export class Features {
	/** null until known; an earlier visit's answer stands in until this visit's arrives. */
	list = $state.raw<readonly WebFeature[] | null>(null);
	/** This visit's /api/me has answered. */
	fresh = $state(false);
	/** Turned on here for fixture screens, whatever the bot says. */
	override = $state.raw<ReadonlySet<AppFeature>>(new Set());
	/** The bot can turn speech into text (POST /api/dictation). */
	dictation = $state(false);

	#load: () => Promise<{ features?: WebFeature[]; dictation?: boolean }>;
	#inflight: Promise<void> | null = null;

	constructor(
		load: () => Promise<{ features?: WebFeature[]; dictation?: boolean }> = api.me,
		initial = cached(),
		override = storedOverride()
	) {
		this.#load = load;
		this.list = initial;
		this.override = override;
	}

	/** Shown in the nav: on as far as anything says. */
	has = (f: AppFeature | undefined): boolean =>
		!f || this.override.has(f) || (isWeb(f) && (this.list?.includes(f) ?? false));

	/**
	 * Known to be off right now, so its screens send you Home. Unknown is never off: a bot
	 * feature counts as off only once this visit's /api/me has answered. A client feature has no
	 * bot answer to wait for, so without the override it is off.
	 */
	off(f: AppFeature): boolean {
		if (this.has(f)) return false;
		return isWeb(f) ? this.fresh : true;
	}

	/** Turns fixture screens on for this device; `null` clears it. */
	setOverride(value: 'all' | AppFeature[] | null) {
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
				const list = WEB_FEATURES.filter((f) => me.features?.includes(f));
				this.list = list;
				this.dictation = me.dictation === true;
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
