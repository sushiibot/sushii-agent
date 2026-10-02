import type { RunKind, RunSummary } from './types';

/** What started the run, in plain words. */
export function kindLabel(run: Pick<RunSummary, 'kind' | 'jobName' | 'agentName'>): string {
	switch (run.kind) {
		case 'chat':
			return 'Chat turn';
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
	description: string;
	kinds?: RunKind[];
}[] = [
	{
		value: 'all',
		label: 'All',
		noun: 'runs',
		description:
			'Includes chat replies, scheduled tasks, delegated work, memory saves and session changes.'
	},
	{
		value: 'chat',
		label: 'Chat',
		noun: 'chat turns',
		description:
			'Each chat run is one response to a message, including its tool calls. A conversation contains many runs.',
		kinds: ['chat']
	},
	{
		value: 'job',
		label: 'Scheduled',
		noun: 'scheduled runs',
		description: 'Tasks started by a schedule, with the schedule name on each record.',
		kinds: ['job']
	},
	{
		value: 'subagent',
		label: 'Background',
		noun: 'background runs',
		description: 'Work delegated by another run. Open a record to see the run that started it.',
		kinds: ['subagent']
	},
	{
		value: 'agent',
		label: 'Agents',
		noun: 'agent runs',
		description: 'Separate agent tasks, with the agent name on each record.',
		kinds: ['agent']
	}
];

export function filterKinds(filter: RunFilter): RunKind[] | undefined {
	return RUN_FILTERS.find((f) => f.value === filter)?.kinds;
}
