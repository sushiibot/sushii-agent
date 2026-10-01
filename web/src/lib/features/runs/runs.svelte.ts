import { Remote } from '$lib/core/remote.svelte';
import type { RunsApi } from './api';
import { fixtureRunsApi } from './fake';
import type { RunDetail, RunStep, RunsPage } from './types';

/** A run's detail with the steps paged in so far. */
export class RunView {
	remote: Remote<RunDetail | null>;
	/** Steps loaded by "Load more steps", after the first page. */
	more = $state.raw<RunStep[]>([]);
	after = $state<string | null>(null);
	moreLoading = $state(false);
	moreError = $state<string | null>(null);

	#api: RunsApi;
	#id: string;

	constructor(api: RunsApi, runId: string) {
		this.#api = api;
		this.#id = runId;
		this.remote = new Remote(
			async () => {
				const detail = await api.get(runId);
				this.more = [];
				this.after = detail?.after ?? null;
				return detail;
			},
			{ refetchOnFocus: true }
		);
	}

	async loadMore() {
		if (!this.after || this.moreLoading) return;
		this.moreLoading = true;
		this.moreError = null;
		try {
			const page = await this.#api.get(this.#id, { after: this.after });
			if (!page) throw new Error('The run is gone.');
			this.more = [...this.more, ...page.steps];
			this.after = page.after;
		} catch (err) {
			this.moreError = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			this.moreLoading = false;
		}
	}
}

export class RunsStore {
	list: Remote<RunsPage>;
	/** Older pages appended under the first. */
	older = $state.raw<RunsPage['runs']>([]);
	before = $state<string | null>(null);
	truncated = $state(false);
	olderLoading = $state(false);
	olderError = $state<string | null>(null);

	#api: RunsApi;
	#runs = new Map<string, RunView>();

	constructor(api: RunsApi = fixtureRunsApi) {
		this.#api = api;
		this.list = new Remote(
			async () => {
				const page = await api.list({});
				this.older = [];
				this.before = page.before;
				this.truncated = page.truncated;
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
			const page = await this.#api.list({ before: this.before });
			this.older = [...this.older, ...page.runs];
			this.before = page.before;
			this.truncated = page.truncated;
		} catch (err) {
			this.olderError = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			this.olderLoading = false;
		}
	}

	/** One run's view, kept while the app runs so back and forth doesn't reload it. */
	run(runId: string): RunView {
		let view = this.#runs.get(runId);
		if (!view) {
			view = new RunView(this.#api, runId);
			this.#runs.set(runId, view);
		}
		return view;
	}
}

let store: RunsStore | null = null;
let configured: RunsApi | undefined;

/** Swaps in another API, for tests; call before the first store. */
export function configureRuns(api: RunsApi) {
	configured = api;
}

export function runsStore(): RunsStore {
	return (store ??= new RunsStore(configured));
}
