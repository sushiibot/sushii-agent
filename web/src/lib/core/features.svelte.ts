import { api } from './api';
import { WEB_FEATURES, type WebFeature } from './realtime/events';

/**
 * Screens that run on fixtures until their backend ships. The bot never lists them in
 * /api/me, so they show only through the override; a backend adds its id to WEB_FEATURES.
 */
export const CLIENT_FEATURES = [
	'threads',
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

const KNOWN = new Set<string>(ALL_FEATURES);
const LIVE_KEY = 'features:live';
/** `all`, or a comma list of feature ids, turned on whatever the bot says. */
export const OVERRIDE_KEY = 'features:override';

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Private mode: the setting lasts for this page view.
	}
}

export function parseFeatures(raw: unknown): AppFeature[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((f): f is AppFeature => typeof f === 'string' && KNOWN.has(f));
}

function parseOverride(raw: string | null): ReadonlySet<AppFeature> {
	if (!raw) return new Set();
	if (raw.trim() === 'all') return new Set(ALL_FEATURES);
	return new Set(parseFeatures(raw.split(',').map((s) => s.trim())));
}

function readLive(): AppFeature[] | null {
	const raw = read(LIVE_KEY);
	if (raw === null) return null;
	try {
		return parseFeatures(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Which slices of the app are on: what /api/me lists, plus the fixture override. */
export class Features {
	/** The bot's list, from /api/me or the copy saved last time; null until either is had. */
	live = $state.raw<AppFeature[] | null>(readLive());
	override = $state.raw<ReadonlySet<AppFeature>>(parseOverride(read(OVERRIDE_KEY)));

	/** Enough is known to hide a screen and send its route Home. */
	readonly known = $derived(this.live !== null || this.override.size === ALL_FEATURES.length);
	readonly enabled = $derived(new Set<AppFeature>([...(this.live ?? []), ...this.override]));

	has = (f: AppFeature | undefined): boolean => !f || this.enabled.has(f);

	#loading: Promise<void> | null = null;

	load(): Promise<void> {
		this.#loading ??= api
			.me()
			.then((me) => {
				this.live = parseFeatures(me.features);
				write(LIVE_KEY, JSON.stringify(this.live));
			})
			.catch(() => {
				// Offline or not the owner: keep the saved list, and try again on the next focus.
			})
			.finally(() => (this.#loading = null));
		return this.#loading;
	}

	/** Turns fixture screens on for this device; `null` clears it. */
	setOverride(value: 'all' | AppFeature[] | null) {
		const raw = value === null ? null : value === 'all' ? 'all' : value.join(',');
		write(OVERRIDE_KEY, raw);
		this.override = parseOverride(raw);
	}

	/** Refetches on focus, so turning a slice on at the bot shows up without a reload. */
	start(): () => void {
		void this.load();
		const onVisible = () => {
			if (document.visibilityState === 'visible') void this.load();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	}
}

export const features = new Features();
