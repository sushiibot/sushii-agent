// View models for Schedules. The bot has no schedule routes yet; this is what they will serve.

/** How a run ended, including the quiet ways, so "nothing happened" never looks like "it broke". */
export type JobResult = 'sent' | 'quiet' | 'suppressed' | 'skipped' | 'outside-hours' | 'failed';

export interface JobRun {
	at: string;
	result: JobResult;
	/** Why, in one line: "12 new, none needed you", "Registry mirror returned 403". */
	note: string;
	runId?: string;
}

export interface Job {
	id: string;
	name: string;
	/** In words: "Daily 07:30", "Every 30 min, 08:00–22:00". */
	schedule: string;
	/** null while paused. */
	nextRun: string | null;
	enabled: boolean;
	last?: JobRun;
}

export interface JobDetail extends Job {
	/** What the job asks the agent to do, plain text. */
	prompt: string;
	/** Newest first. */
	runs: JobRun[];
}

/** A test run's progress: the job runs now with sending turned off. */
export type TestRun =
	| { state: 'running'; step: string }
	| { state: 'done'; result: JobResult; note: string; runId?: string }
	| { state: 'failed'; note: string };
