import type { Job, JobDetail, TestRun } from './types';

export interface SchedulesApi {
	list(): Promise<Job[]>;
	/** null: no such job. */
	get(id: string): Promise<JobDetail | null>;
	setEnabled(id: string, enabled: boolean): Promise<JobDetail>;
	/** Runs the job now with sending off; calls `onstep` as it goes and resolves to the result. */
	testRun(id: string, onstep: (t: TestRun) => void): Promise<TestRun>;
}
