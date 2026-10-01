import type { ChatEnvelope } from '$lib/core/realtime/events';
import { hub as appHub, type Hub } from '$lib/core/realtime/hub.svelte';
import { Remote } from '$lib/core/remote.svelte';
import { httpRunsApi, type RunsApi } from './api';
import type { RunDetail, RunStatus, RunStep, RunSummary, RunsPage } from './types';

const REFRESH_DEBOUNCE_MS = 1000;

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

	/** A live status change; the rest (end time, last steps) comes with the refetch. */
	patchStatus(status: RunStatus) {
		const d = this.remote.data;
		if (d && d.run.status !== status) this.remote.data = { ...d, run: { ...d.run, status } };
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
	#hub: Hub;
	#runs = new Map<string, RunView>();
	#stop: (() => void) | null = null;
	#headTimer: ReturnType<typeof setTimeout> | null = null;
	#detailTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(api: RunsApi = httpRunsApi, hub: Hub = appHub) {
		this.#api = api;
		this.#hub = hub;
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
		this.start();
		let view = this.#runs.get(runId);
		if (!view) {
			view = new RunView(this.#api, runId);
			this.#runs.set(runId, view);
		}
		return view;
	}

	/** Follows `run` events (job, subagent and agent runs) for the app's life; later calls do nothing. */
	start() {
		if (this.#stop) return;
		this.#stop = this.#hub.subscribe({ conversation: 'main', types: ['run'] }, (batch) => {
			for (const ev of batch) this.#onRun(ev);
		});
		this.#hub.start();
	}

	#onRun(ev: ChatEnvelope) {
		if (ev.type !== 'run') return;
		const { runId, status, parentRunId } = ev.data;
		const patch = (runs: RunSummary[]) =>
			runs.some((r) => r.runId === runId && r.status !== status)
				? runs.map((r) => (r.runId === runId ? { ...r, status } : r))
				: runs;
		const head = this.list.data;
		const known =
			!!head?.runs.some((r) => r.runId === runId) || this.older.some((r) => r.runId === runId);
		if (head) {
			const runs = patch(head.runs);
			if (runs !== head.runs) this.list.data = { ...head, runs };
		}
		this.older = patch(this.older);
		// A new run, or an end time and summary the event doesn't carry.
		if (head && (!known || status !== 'running')) this.#scheduleHead();
		this.#runs.get(runId)?.patchStatus(status);
		for (const id of [runId, parentRunId]) if (id && this.#runs.has(id)) this.#scheduleDetail(id);
	}

	#scheduleHead() {
		if (this.#headTimer) clearTimeout(this.#headTimer);
		this.#headTimer = setTimeout(() => {
			this.#headTimer = null;
			void this.#refreshHead();
		}, REFRESH_DEBOUNCE_MS);
	}

	/** Reloads the newest page in place, keeping the older pages already shown. */
	async #refreshHead() {
		const head = this.list.data;
		if (this.list.status !== 'ready' || !head) return;
		try {
			const page = await this.#api.list({});
			// A full reload started meanwhile and wins.
			if (this.list.status !== 'ready') return;
			if (!this.older.length) {
				this.list.data = page;
				this.before = page.before;
				this.truncated = page.truncated;
				return;
			}
			// Runs the new page pushed down move into the older list, so paging still continues from
			// the same cursor without a gap or a repeat.
			const seen = new Set<string>();
			const merged = [...page.runs, ...(this.list.data ?? head).runs, ...this.older]
				.filter((r) => !seen.has(r.runId) && !!seen.add(r.runId))
				.sort((a, b) => (a.runId < b.runId ? 1 : -1));
			this.list.data = { ...page, runs: merged.slice(0, page.runs.length) };
			this.older = merged.slice(page.runs.length);
		} catch {
			// The list stays as it was; the next event or focus tries again.
		}
	}

	#scheduleDetail(runId: string) {
		clearTimeout(this.#detailTimers.get(runId));
		this.#detailTimers.set(
			runId,
			setTimeout(() => {
				this.#detailTimers.delete(runId);
				const view = this.#runs.get(runId);
				if (view && view.remote.status === 'ready') void view.remote.refetch();
			}, REFRESH_DEBOUNCE_MS)
		);
	}
}

let store: RunsStore | null = null;
let configured: RunsApi | undefined;

/** Swaps in another API, for tests and dev mode; call before the first store. */
export function configureRuns(api: RunsApi) {
	configured = api;
}

export function runsStore(): RunsStore {
	if (!store) {
		store = new RunsStore(configured);
		store.start();
	}
	return store;
}
