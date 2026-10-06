import type { RunKind, RunStatus, RunSummary } from './types';

export function executionLabel(status: RunStatus): string {
	return {
		running: 'Running',
		done: 'Finished',
		failed: 'Failed',
		aborted: 'Stopped',
		timeout: 'Timed out'
	}[status];
}

/** What started the run, in plain words. */
export function kindLabel(run: Pick<RunSummary, 'kind' | 'jobName' | 'agentName'>): string {
	switch (run.kind) {
		case 'chat':
			return 'Reply';
		case 'flush':
			return 'Memory save';
		case 'rotate':
			return 'Context refresh';
		case 'job':
			return run.jobName ? `Scheduled · ${run.jobName}` : 'Scheduled';
		case 'subagent':
			return `Delegated · ${run.agentName}`;
		case 'agent':
			return `Task · ${run.agentName}`;
	}
}

export function runTime(run: RunSummary): number {
	return Date.parse(run.startedAt);
}

/** A display title is separate from the original request, which stays in Details. */
export function activityTitle(run: Pick<RunSummary, 'kind' | 'title' | 'agentName'>): string {
	if (run.kind === 'chat') return 'Reply activity';
	if (run.kind === 'flush') return 'Memory save';
	if (run.kind === 'rotate') return 'Context refresh';
	if (run.title.trim() && run.title.length <= 80) return run.title;
	return run.kind === 'job' ? 'Scheduled task' : `${run.agentName} task`;
}

export type RunFilter = 'work' | 'all' | 'chat' | 'job' | 'subagent' | 'agent';

/** Work starts with assignments; Activity includes reply cycles and system events. */
export const RUN_FILTERS: readonly {
	value: RunFilter;
	label: string;
	/** What the list holds, for its empty state. */
	noun: string;
	description: string;
	kinds?: RunKind[];
}[] = [
	{
		value: 'work',
		label: 'Tasks',
		noun: 'tasks',
		description: 'Delegated tasks, separate agent assignments and scheduled work.',
		kinds: ['job', 'subagent', 'agent']
	},
	{
		value: 'job',
		label: 'Scheduled',
		noun: 'scheduled tasks',
		description: 'Tasks started by a schedule, with the schedule name on each record.',
		kinds: ['job']
	},
	{
		value: 'subagent',
		label: 'Delegated',
		noun: 'delegated tasks',
		description:
			'Assignments from another agent. Open a task to see its conversation and parent activity.',
		kinds: ['subagent']
	},
	{
		value: 'agent',
		label: 'Agents',
		noun: 'agent tasks',
		description: 'Separate agent tasks, with the agent name on each record.',
		kinds: ['agent']
	},
	{
		value: 'chat',
		label: 'Replies',
		noun: 'replies',
		description: 'Execution details for individual replies. Continue the conversation in chat.',
		kinds: ['chat']
	},
	{
		value: 'all',
		label: 'Activity',
		noun: 'activity',
		description: 'The execution log: replies, tasks, memory saves and context refreshes.'
	}
];

export function filterKinds(filter: RunFilter): RunKind[] | undefined {
	return RUN_FILTERS.find((f) => f.value === filter)?.kinds;
}
