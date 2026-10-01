import { Remote } from '$lib/core/remote.svelte';
import { httpHistoryApi, type HistoryApi } from './api';
import {
	QUERY_MAX,
	QUERY_MIN,
	type HistoryDayDetail,
	type HistoryDaysPage,
	type SearchResult
} from './types';

const DEBOUNCE_MS = 250;
const SLOW_MS = 300;

/** Search as you type: one request at a time, the newest query wins. */
export class HistorySearch {
	query = $state('');
	status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	slow = $state(false);
	error = $state<string | null>(null);
	result = $state.raw<SearchResult | null>(null);

	#api: HistoryApi;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#slowTimer: ReturnType<typeof setTimeout> | undefined;
	#run = 0;
	#abort: AbortController | null = null;

	constructor(api: HistoryApi) {
		this.#api = api;
	}

	/** The query as typed; searches once typing pauses and it has at least two characters. */
	set(query: string) {
		this.query = query.slice(0, QUERY_MAX);
		clearTimeout(this.#timer);
		const q = this.query.trim();
		if (Array.from(q).length < QUERY_MIN) {
			this.#cancel();
			this.status = 'idle';
			this.result = null;
			return;
		}
		if (this.result?.query === q && this.status === 'ready') return;
		this.#timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
	}

	#cancel() {
		this.#run++;
		this.#abort?.abort();
		this.#abort = null;
		clearTimeout(this.#slowTimer);
		this.slow = false;
	}

	async run() {
		const q = this.query.trim();
		if (Array.from(q).length < QUERY_MIN) return;
		this.#cancel();
		const run = this.#run;
		const abort = (this.#abort = new AbortController());
		this.status = 'loading';
		this.error = null;
		this.#slowTimer = setTimeout(() => {
			if (run === this.#run) this.slow = true;
		}, SLOW_MS);
		try {
			const result = await this.#api.search(q, abort.signal);
			if (run !== this.#run) return;
			this.result = result;
			this.status = 'ready';
		} catch (err) {
			if (run !== this.#run) return;
			this.error = err instanceof Error ? err.message : 'Something went wrong.';
			this.status = 'error';
		} finally {
			if (run === this.#run) {
				clearTimeout(this.#slowTimer);
				this.slow = false;
			}
		}
	}
}

export class HistoryStore {
	days: Remote<HistoryDaysPage>;
	older = $state.raw<HistoryDaysPage['days']>([]);
	before = $state<string | null>(null);
	olderLoading = $state(false);
	olderError = $state<string | null>(null);
	search: HistorySearch;

	#api: HistoryApi;
	#days = new Map<string, Remote<HistoryDayDetail>>();

	constructor(api: HistoryApi = httpHistoryApi) {
		this.#api = api;
		this.search = new HistorySearch(api);
		this.days = new Remote(
			async () => {
				const page = await api.days({});
				this.older = [];
				this.before = page.before;
				return page;
			},
			{ refetchOnFocus: true }
		);
	}

	async loadOlder() {
		if (!this.before || this.olderLoading) return;
		this.olderLoading = true;
		this.olderError = null;
		try {
			const page = await this.#api.days({ before: this.before });
			this.older = [...this.older, ...page.days];
			this.before = page.before;
		} catch (err) {
			this.olderError = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			this.olderLoading = false;
		}
	}

	/** One day's page, kept for the app's life so back and forth doesn't reload it. */
	day(date: string): Remote<HistoryDayDetail> {
		let remote = this.#days.get(date);
		if (!remote) {
			remote = new Remote(() => this.#api.day(date));
			this.#days.set(date, remote);
		}
		return remote;
	}
}

let store: HistoryStore | null = null;
let configured: HistoryApi | undefined;

/** Swaps in another API, for tests; call before the first store. */
export function configureHistory(api: HistoryApi) {
	configured = api;
}

export function historyStore(): HistoryStore {
	return (store ??= new HistoryStore(configured));
}
