import { request } from '$lib/core/http';
import { hub } from '$lib/core/realtime/hub.svelte';
import type { RunsPage, RunSummary, RunDetail } from './types';
import { RunActivityCache, latestActivity } from './activity';

/** Shared per conversation so timeline cards and the composer strip use one live subscription. */
class BackgroundWork {
	runs = $state.raw<RunSummary[]>([]);
	activity = $state.raw<Record<string, string>>({});
	#fetching = false;
	#users = 0;
	#stop?: () => void;
	#timer?: ReturnType<typeof setInterval>;
	#activity = new RunActivityCache((runId, after) =>
		request<RunDetail>('GET', `/runs/${runId}${after ? `?after=${encodeURIComponent(after)}` : ''}`)
	);
	constructor(readonly conversationId: string) {}
	async readActivity(runId: string) {
		const detail = await this.#activity.read(runId);
		const label = latestActivity(detail.steps);
		if (label !== undefined) this.activity = { ...this.activity, [runId]: label };
		return detail;
	}
	async refresh() {
		if (this.#fetching) return;
		this.#fetching = true;
		try {
			const page = await request<RunsPage>(
				'GET',
				`/runs?kind=subagent&conversationId=${encodeURIComponent(this.conversationId)}&limit=50`
			);
			const running = await request<RunsPage>(
				'GET',
				`/runs?kind=subagent&status=running&conversationId=${encodeURIComponent(this.conversationId)}&limit=50`
			);
			this.runs = [...new Map([...page.runs, ...running.runs].map((r) => [r.runId, r])).values()];
			const active = this.runs.filter((r) => r.status === 'running');
			await Promise.all(
				active.map(async (r) => {
					try {
						await this.readActivity(r.runId);
					} catch {
						/* Preserve the last activity when details are temporarily offline. */
					}
				})
			);
		} catch {
			/* Preserve the last known tasks through a temporary disconnect. */
		} finally {
			this.#fetching = false;
		}
	}
	connect() {
		if (this.#users++ === 0) {
			void this.refresh();
			this.#stop = hub.subscribe({ types: ['run'] }, () => void this.refresh());
			this.#timer = setInterval(() => {
				if (this.runs.some((r) => r.status === 'running')) void this.refresh();
			}, 3000);
		}
		return () => {
			if (--this.#users === 0) {
				this.#stop?.();
				clearInterval(this.#timer);
			}
		};
	}
}
const stores = new Map<string, BackgroundWork>();
export function backgroundWork(conversationId: string) {
	let store = stores.get(conversationId);
	if (!store) {
		store = new BackgroundWork(conversationId);
		stores.set(conversationId, store);
	}
	return store;
}
