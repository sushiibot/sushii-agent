import type { RunSummary } from './types';

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
