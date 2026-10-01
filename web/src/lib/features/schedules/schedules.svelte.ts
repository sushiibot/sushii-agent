import { Remote } from '$lib/core/remote.svelte';
import { httpSchedulesApi, type SchedulesApi } from './api';
import type { Job, JobDetail, TestRun } from './types';

export class SchedulesStore {
	list: Remote<Job[]>;
	busy = $state(false);
	error = $state<string | null>(null);
	/** Test runs by job id, kept while you look elsewhere. */
	tests = $state<Record<string, TestRun>>({});

	#api: SchedulesApi;
	#jobs = new Map<string, Remote<JobDetail | null>>();

	constructor(api: SchedulesApi = httpSchedulesApi) {
		this.#api = api;
		this.list = new Remote(() => api.list(), { refetchOnFocus: true });
	}

	job(id: string) {
		let r = this.#jobs.get(id);
		if (!r) this.#jobs.set(id, (r = new Remote(() => this.#api.get(id))));
		return r;
	}

	async setEnabled(id: string, enabled: boolean) {
		this.busy = true;
		this.error = null;
		try {
			this.job(id).data = await this.#api.setEnabled(id, enabled);
			void this.list.refetch();
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			this.busy = false;
		}
	}

	async testRun(id: string) {
		if (this.tests[id]?.state === 'running') return;
		try {
			const result = await this.#api.testRun(id, (t) => (this.tests[id] = t));
			this.tests[id] = result;
		} catch (err) {
			this.tests[id] = {
				state: 'failed',
				note: err instanceof Error ? err.message : 'The test run did not start.'
			};
		}
	}
}

let store: SchedulesStore | null = null;
let configured: SchedulesApi | undefined;

export function configureSchedules(api: SchedulesApi) {
	configured = api;
}

export function schedulesStore(): SchedulesStore {
	return (store ??= new SchedulesStore(configured));
}
