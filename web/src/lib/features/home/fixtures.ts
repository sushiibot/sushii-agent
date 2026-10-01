// Typed fixtures for Home, shared by the fake API, the prototype board and tests. Every time is
// relative to `now`, so the screens read the same whenever they are rendered.
import type { AskView, PendingApproval } from '$lib/features/chat';
import type { RunSummary } from '$lib/features/runs';
import type { HomeAlert, HomeData, HomeGroups, HomeItem, TurnItem } from './types';

const MIN = 60_000;
const iso = (now: number, minsAgo: number) => new Date(now - minsAgo * MIN).toISOString();

export const RUN_IDS = {
	nightlySync: '01K6B2N8W3J5Q7R9T1V3X5Z7A9',
	flights: '01K6B0Q4S6V8W0Y2A4C6E8G0J2',
	triage: '01K6B4D2F4H6K8M0P2R4T6V8X0',
	expenses: '01K6B3A1C3E5G7J9M1P3R5T7V9',
	weeklyDeps: '01K6AZ8B0D2F4H6K8M0P2R4T6V'
} as const;

export function nightlyAlert(now: number): HomeAlert {
	return {
		id: 'job:nightly-sync',
		job: 'nightly-sync',
		kind: 'failed',
		firstAt: iso(now, 190),
		lastAt: iso(now, 10),
		trigger: 'interval',
		error: 'rsync: connection to backup.lan timed out after 30s (exit 30)',
		schedule: 'every 3 hours',
		runId: RUN_IDS.nightlySync,
		seq: 812
	};
}

export function stuckAlert(now: number): HomeAlert {
	return {
		id: 'job:inbox-digest',
		job: 'inbox-digest',
		kind: 'stuck',
		firstAt: iso(now, 75),
		lastAt: iso(now, 75),
		trigger: 'daily',
		schedule: 'daily at 08:00',
		disabled: true,
		seq: 790
	};
}

export function flightsRun(now: number): RunSummary {
	return {
		runId: RUN_IDS.flights,
		kind: 'subagent',
		agentName: 'researcher',
		parentRunId: RUN_IDS.expenses,
		title: 'Compare flight prices for the October trip',
		status: 'timeout',
		startedAt: iso(now, 90),
		endedAt: iso(now, 60),
		resultSummary: 'Stopped after 30 minutes with 2 of 4 airlines checked.'
	};
}

export function triageRun(now: number): RunSummary {
	return {
		runId: RUN_IDS.triage,
		kind: 'job',
		agentName: 'main',
		jobName: 'inbox-triage',
		title: 'Sort new mail and flag anything urgent',
		status: 'running',
		startedAt: iso(now, 4)
	};
}

export function expensesRun(now: number): RunSummary {
	return {
		runId: RUN_IDS.expenses,
		kind: 'subagent',
		agentName: 'writer',
		title: 'Draft the quarterly expenses summary',
		status: 'done',
		startedAt: iso(now, 95),
		endedAt: iso(now, 50),
		resultSummary: 'Wrote projects/finance/q3-summary.md (2 pages).'
	};
}

export function depsRun(now: number): RunSummary {
	return {
		runId: RUN_IDS.weeklyDeps,
		kind: 'job',
		agentName: 'main',
		jobName: 'weekly-deps',
		title: 'Check dependencies for updates',
		status: 'done',
		startedAt: iso(now, 26 * 60),
		endedAt: iso(now, 26 * 60 - 4),
		resultSummary: '3 updates available; none are security fixes.'
	};
}

/** What GET /api/home answers, minus the live parts. */
export function homeData(now: number): HomeData {
	return {
		asOf: iso(now, 0),
		auth: null,
		failed: [nightlyAlert(now)],
		workspace: {
			state: 'online',
			running: [triageRun(now)],
			failedRuns: [flightsRun(now)],
			review: [expensesRun(now), depsRun(now)]
		}
	};
}

export const emptyHomeData = (now: number): HomeData => ({
	asOf: iso(now, 0),
	auth: null,
	failed: [],
	workspace: { state: 'online', running: [], failedRuns: [], review: [] }
});

export const emailApproval: PendingApproval = {
	nonce: 'n-email-sam',
	view: {
		tool: 'send_email',
		agentId: 'main',
		agentName: 'sushii-agent',
		fields: [
			{ key: 'to', value: 'sam@eastside-auto.example', kind: 'single', max: 200 },
			{ key: 'subject', value: 'Re: Invoice #1042', kind: 'single', max: 200 },
			{
				key: 'body',
				value:
					'Hi Sam,\n\nThanks for the invoice. Payment is scheduled for the 12th.\n\nBest,\nDaniel',
				kind: 'body'
			}
		]
	}
};

export const issueApproval: PendingApproval = {
	nonce: 'n-linear-issue',
	view: {
		tool: 'file_linear_issue',
		agentId: RUN_IDS.expenses,
		agentName: 'writer',
		fields: [
			{ key: 'title', value: 'Q3 summary: receipts missing for 2 trips', kind: 'single', max: 200 },
			{ key: 'team', value: 'Personal', kind: 'single', max: 80 }
		]
	}
};

export const serviceAsk: AskView = {
	askId: 'ask-car-service',
	question: 'Which day works for the car service at Eastside Auto?',
	choices: ['Friday 9:00', 'Saturday 10:30'],
	state: 'pending'
};

export function mainTurn(now: number): TurnItem {
	return {
		turnId: 'turn-1',
		startedAt: now - 45_000,
		step: "Searching mail for 'invoice'",
		toolCount: 3
	};
}

/** Every group filled, as the prototype and screenshots show it. */
export function busyGroups(now: number): HomeGroups {
	const data = homeData(now);
	const online = data.workspace.state === 'online' ? data.workspace : null;
	const run = (group: 'failed' | 'running' | 'review', r: RunSummary): HomeItem => ({
		id: `run:${r.runId}`,
		group,
		kind: 'run',
		at: r.endedAt ?? r.startedAt,
		run: r
	});
	return {
		waiting: [
			{
				id: `approval:${emailApproval.nonce}`,
				group: 'waiting',
				kind: 'approval',
				at: iso(now, 3),
				approval: emailApproval
			},
			{
				id: `ask:${serviceAsk.askId}`,
				group: 'waiting',
				kind: 'ask',
				at: iso(now, 14),
				ask: serviceAsk
			}
		],
		failed: [
			{
				id: data.failed[0].id,
				group: 'failed',
				kind: 'alert',
				at: data.failed[0].lastAt,
				alert: data.failed[0]
			},
			...(online?.failedRuns ?? []).map((r) => run('failed', r))
		],
		running: [
			{
				id: 'turn:turn-1',
				group: 'running',
				kind: 'turn',
				at: iso(now, 1),
				turn: mainTurn(now)
			},
			...(online?.running ?? []).map((r) => run('running', r))
		],
		review: (online?.review ?? []).map((r) => run('review', r))
	};
}

export const noGroups = (): HomeGroups => ({ waiting: [], failed: [], running: [], review: [] });
