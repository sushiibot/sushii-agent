import type { RunKind, RunSummary } from './types';

/** What started the run, in plain words. */
export function kindLabel(run: Pick<RunSummary, 'kind' | 'jobName' | 'agentName'>): string {
	switch (run.kind) {
		case 'chat':
			return 'Chat';
		case 'flush':
			return 'Memory save';
		case 'rotate':
			return 'New session';
		case 'job':
			return run.jobName ? `Scheduled · ${run.jobName}` : 'Scheduled';
		case 'subagent':
			return `Background · ${run.agentName}`;
		case 'agent':
			return `Agent · ${run.agentName}`;
	}
}

export function runTime(run: RunSummary): number {
	return Date.parse(run.startedAt);
}

export type RunFilter = 'all' | 'chat' | 'job' | 'subagent' | 'agent';

/** The Runs list's type filter. Memory saves and session rotations show only under All. */
export const RUN_FILTERS: readonly {
	value: RunFilter;
	label: string;
	/** What the list holds, for its empty state. */
	noun: string;
	kinds?: RunKind[];
}[] = [
	{ value: 'all', label: 'All', noun: 'runs' },
	{ value: 'chat', label: 'Chat', noun: 'chat turns', kinds: ['chat'] },
	{ value: 'job', label: 'Scheduled', noun: 'scheduled runs', kinds: ['job'] },
	{ value: 'subagent', label: 'Background', noun: 'background runs', kinds: ['subagent'] },
	{ value: 'agent', label: 'Agents', noun: 'agent runs', kinds: ['agent'] }
];

export function filterKinds(filter: RunFilter): RunKind[] | undefined {
	return RUN_FILTERS.find((f) => f.value === filter)?.kinds;
}
