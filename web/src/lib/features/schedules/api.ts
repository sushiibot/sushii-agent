import { enc, featureHttp } from '$lib/core/feature-http';
import type { Job, JobDetail, TestRun } from './types';

export interface SchedulesApi {
	list(): Promise<Job[]>;
	/** null: no such job. */
	get(id: string): Promise<JobDetail | null>;
	setEnabled(id: string, enabled: boolean): Promise<JobDetail>;
	/** Runs the job now with sending off; calls `onstep` as it goes and resolves to the result. */
	testRun(id: string, onstep: (t: TestRun) => void): Promise<TestRun>;
}

const http = featureHttp("Schedules aren't available yet.");

export const httpSchedulesApi: SchedulesApi = {
	list: () => http.get('/schedules'),
	get: (id) => http.find(`/schedules/${enc(id)}`),
	setEnabled: (id, enabled) => http.post(`/schedules/${enc(id)}/enabled`, { enabled }),
	async testRun(id, onstep) {
		onstep({ state: 'running', step: 'Running the job with sending off' });
		return http.post(`/schedules/${enc(id)}/test`);
	}
};
