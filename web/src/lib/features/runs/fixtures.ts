// Typed fixtures for Runs, shared by the fake API, the prototype board and tests. Ids and titles
// match Home's fixtures, so "Open run" from a Home peek lands on the same run.
import type { UploadRef } from '$lib/core/realtime/events';
import type { RunDetail, RunStep, RunSummary } from './types';

const MIN = 60_000;
const iso = (now: number, minsAgo: number) => new Date(now - minsAgo * MIN).toISOString();

export const RUNS = {
	triage: '01K6B4D2F4H6K8M0P2R4T6V8X0',
	invoice: '01K6B4A0C2E4G6J8M0P2R4T6V8',
	nightlySync: '01K6B2N8W3J5Q7R9T1V3X5Z7A9',
	expenses: '01K6B3A1C3E5G7J9M1P3R5T7V9',
	flights: '01K6B0Q4S6V8W0Y2A4C6E8G0J2',
	service: '01K6AZZ1B3D5F7H9K1M3P5R7T9',
	refactor: '01K6AZT2V4X6Z8B0D2F4H6K8M0',
	flush: '01K6AZQ7S9V1X3Z5B7D9F1H3K5',
	weeklyDeps: '01K6AZ8B0D2F4H6K8M0P2R4T6V',
	hoa: '01K6AY4C6E8G0J2M4P6R8T0W2Y',
	rotate: '01K6AW1D3F5H7K9N1Q3S5V7X9Z',
	brief: '01K6AW0E2G4J6M8P0R2T4W6Y8A',
	syncOld: '01K6AT9F1H3K5N7Q9S1V3X5Z7B'
} as const;

export function runSummaries(now: number): RunSummary[] {
	return summaries(now).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function summaries(now: number): RunSummary[] {
	const usage = (i: number, o: number, c: number) => ({
		inputTokens: i,
		outputTokens: o,
		costUsd: c,
		model: 'anthropic/claude-sonnet-4.5'
	});
	return [
		{
			runId: RUNS.triage,
			kind: 'job',
			agentName: 'main',
			jobName: 'inbox-triage',
			title: 'Sort new mail and flag anything urgent',
			status: 'running',
			startedAt: iso(now, 4)
		},
		{
			runId: RUNS.nightlySync,
			kind: 'job',
			agentName: 'main',
			jobName: 'nightly-sync',
			title: 'Back up projects to the home server',
			status: 'failed',
			startedAt: iso(now, 11),
			endedAt: iso(now, 10),
			usage: usage(18_420, 640, 0.0612),
			resultSummary: 'rsync could not reach backup.lan (exit 30).'
		},
		{
			runId: RUNS.invoice,
			kind: 'chat',
			agentName: 'main',
			turnId: 'turn-41',
			title: "What's the invoice from Eastside Auto about?",
			status: 'done',
			startedAt: iso(now, 100),
			endedAt: iso(now, 99),
			usage: usage(42_118, 1_204, 0.1421),
			resultSummary: 'Explained invoice #1042 and offered to schedule payment.'
		},
		{
			runId: RUNS.expenses,
			kind: 'subagent',
			agentName: 'writer',
			parentRunId: RUNS.invoice,
			title: 'Draft the quarterly expenses summary',
			status: 'done',
			startedAt: iso(now, 95),
			endedAt: iso(now, 50),
			usage: usage(212_904, 9_870, 0.7832),
			resultSummary: 'Wrote projects/finance/q3-summary.md (2 pages).'
		},
		{
			runId: RUNS.service,
			kind: 'chat',
			agentName: 'main',
			title: 'Book the car service for Friday',
			status: 'aborted',
			startedAt: iso(now, 180),
			endedAt: iso(now, 178),
			usage: usage(9_310, 211, 0.0301)
		},
		{
			runId: RUNS.flights,
			kind: 'subagent',
			agentName: 'researcher',
			parentRunId: RUNS.expenses,
			title: 'Compare flight prices for the October trip',
			status: 'timeout',
			startedAt: iso(now, 90),
			endedAt: iso(now, 60),
			usage: usage(98_400, 3_120, 0.3366),
			resultSummary: 'Stopped after 30 minutes with 2 of 4 airlines checked.'
		},
		{
			runId: RUNS.refactor,
			kind: 'agent',
			agentName: 'coder',
			title: 'Split the web shell into a layout and per-screen headers',
			status: 'done',
			startedAt: iso(now, 430),
			endedAt: iso(now, 352),
			usage: usage(1_840_220, 52_310, 6.2144),
			resultSummary: 'Moved the tab bar into the layout; 162 steps; tests pass.'
		},
		{
			runId: RUNS.flush,
			kind: 'flush',
			agentName: 'main',
			title: 'Save notes to memory before the session compacts',
			status: 'done',
			startedAt: iso(now, 480),
			endedAt: iso(now, 479)
		},
		{
			runId: RUNS.weeklyDeps,
			kind: 'job',
			agentName: 'main',
			jobName: 'weekly-deps',
			title: 'Check dependencies for updates',
			status: 'done',
			startedAt: iso(now, 26 * 60),
			endedAt: iso(now, 26 * 60 - 4),
			usage: usage(31_002, 880, 0.1054),
			resultSummary: '3 updates available; none are security fixes.'
		},
		{
			runId: RUNS.hoa,
			kind: 'chat',
			agentName: 'main',
			title: 'Summarise the HOA meeting notes',
			status: 'done',
			startedAt: iso(now, 30 * 60),
			endedAt: iso(now, 30 * 60 - 1),
			usage: usage(12_540, 690, 0.0478)
		},
		{
			runId: RUNS.rotate,
			kind: 'rotate',
			agentName: 'main',
			title: 'Start a new session',
			status: 'done',
			startedAt: iso(now, 50 * 60),
			endedAt: iso(now, 50 * 60)
		},
		{
			runId: RUNS.brief,
			kind: 'job',
			agentName: 'main',
			jobName: 'morning-brief',
			title: "Write this morning's brief",
			status: 'done',
			startedAt: iso(now, 52 * 60),
			endedAt: iso(now, 52 * 60 - 2),
			usage: usage(28_330, 1_502, 0.1144)
		},
		{
			runId: RUNS.syncOld,
			kind: 'job',
			agentName: 'main',
			jobName: 'nightly-sync',
			title: 'Back up projects to the home server',
			status: 'done',
			startedAt: iso(now, 75 * 60),
			endedAt: iso(now, 75 * 60 - 3)
		}
	];
}

const tool = (
	id: string,
	at: string,
	name: string,
	args: string,
	ok: boolean | null,
	result: string,
	durationMs?: number
): RunStep => ({ type: 'tool', id, at, name, args, ok, result, durationMs });

const base = (run: RunSummary): RunDetail => ({
	run,
	children: [],
	session: 'ok',
	steps: [],
	after: null,
	approvals: [],
	files: []
});

const q3Pdf: UploadRef = {
	id: 'Q3SummaryPdfUploadId0001',
	contentType: 'application/pdf',
	bytes: 48_213,
	name: 'q3-summary.pdf',
	inline: false
};

/** Steps 100 at a time, as the server pages them. */
export const STEP_PAGE = 100;

function longSteps(run: RunSummary): RunStep[] {
	const start = Date.parse(run.startedAt);
	const files = ['shell.svelte', 'screen.svelte', 'tabs.ts', 'layout.svelte', 'list-screen.svelte'];
	return Array.from({ length: 162 }, (_, i): RunStep => {
		const at = new Date(start + i * 28_000).toISOString();
		const file = files[i % files.length];
		if (i === 0) {
			return {
				type: 'user',
				id: 's0',
				at,
				text: 'Split the web shell into a layout-owned tab bar and per-screen headers. Keep every e2e test green.'
			};
		}
		if (i % 40 === 0) {
			return {
				type: 'assistant',
				id: `s${i}`,
				at,
				text: `Checkpoint ${i / 40}: moved the tab bar for **${file}**; next I run the checks again.`
			};
		}
		if (i % 7 === 0) {
			return tool(
				`s${i}`,
				at,
				'bash',
				'cd projects/sushii-agent/web && bun run check && bunx playwright test e2e/app.test.ts',
				i !== 21,
				i === 21
					? "Error: expect(locator).toBeVisible() failed\n  Locator: getByRole('navigation', { name: 'Main' })\n  Expected: visible\n  Received: hidden"
					: 'svelte-check found 0 errors and 0 warnings\n  58 passed (41.2s)',
				i === 21 ? 44_100 : 52_300
			);
		}
		return tool(
			`s${i}`,
			at,
			i % 2 ? 'edit' : 'read',
			`projects/sushii-agent/web/src/lib/ui/shell/${file}`,
			true,
			i % 2 ? 'Applied 1 edit.' : `Read 128 lines from ${file}.`,
			300 + (i % 5) * 120
		);
	});
}

/** A run's detail with all of its steps, before paging. */
export function runDetailFull(now: number, runId: string): RunDetail | null {
	const runs = runSummaries(now);
	const run = runs.find((r) => r.runId === runId);
	if (!run) return null;
	const at = (m: number) => new Date(Date.parse(run.startedAt) + m * 1000).toISOString();
	switch (runId) {
		case RUNS.triage:
			return {
				...base(run),
				steps: [
					{
						type: 'user',
						id: 't0',
						at: at(0),
						text: 'Scheduled job inbox-triage: sort new mail and flag anything urgent.'
					},
					tool('t1', at(4), 'search_mail', 'is:unread newer_than:1d', true, '14 messages', 1_820),
					tool(
						't2',
						at(9),
						'read_mail',
						'14 messages, headers and first 2 KB',
						true,
						'Read 14 messages.',
						6_410
					),
					tool('t3', at(40), 'label_mail', 'label "Urgent" on 2 messages', null, '')
				],
				evidence: {
					checks: [],
					changedRepos: [],
					checkAfterLastChange: null,
					verifyNudged: false,
					filesSent: [],
					memoryWrites: []
				}
			};
		case RUNS.nightlySync:
			return {
				...base(run),
				steps: [
					{
						type: 'user',
						id: 'n0',
						at: at(0),
						text: 'Scheduled job nightly-sync: back up ~/projects to backup.lan.'
					},
					tool(
						'n1',
						at(2),
						'bash',
						'rsync -az --delete ~/projects/ backup.lan:/srv/backup/projects/',
						false,
						'ssh: connect to host backup.lan port 22: Connection timed out\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]\nrsync error: error in rsync protocol data stream (code 12) at io.c(232)',
						30_512
					),
					tool(
						'n2',
						at(34),
						'bash',
						'ping -c 3 backup.lan',
						false,
						'3 packets transmitted, 0 received, 100% packet loss',
						3_004
					),
					{
						type: 'note',
						id: 'n3',
						at: at(38),
						kind: 'error',
						text: 'Job failed: rsync exited with code 30 after 3 tries.'
					}
				],
				evidence: {
					checks: [{ command: 'ping -c 3 backup.lan', ok: false, at: at(34) }],
					changedRepos: [],
					checkAfterLastChange: null,
					verifyNudged: false,
					filesSent: [],
					memoryWrites: []
				},
				historyFile: `${run.startedAt.slice(0, 7)}/${run.startedAt.slice(8, 10)}-${run.runId}.md`
			};
		case RUNS.expenses:
			return {
				...base(run),
				parent: runs.find((r) => r.runId === run.parentRunId),
				children: runs.filter((r) => r.parentRunId === run.runId),
				steps: [
					{
						type: 'user',
						id: 'e0',
						at: at(0),
						text: 'Draft the Q3 expenses summary from projects/finance/receipts.csv. Two pages at most; flag missing receipts.'
					},
					tool('e1', at(5), 'read', 'projects/finance/receipts.csv', true, 'Read 214 rows.', 210),
					tool(
						'e2',
						at(30),
						'subagent',
						'researcher: compare flight prices for the October trip',
						null,
						'',
						undefined
					),
					tool(
						'e3',
						at(260),
						'bash',
						'cd projects/finance && python summarize.py --quarter 3',
						true,
						'Wrote q3-summary.md (1,412 words). 2 receipts missing: Sep 3, Sep 18.',
						8_204
					),
					tool(
						'e4',
						at(300),
						'bash',
						'cd projects/finance && bun test',
						true,
						'12 pass, 0 fail',
						2_930
					),
					tool('e5', at(330), 'edit', '~/memory/finance.md', true, 'Applied 1 edit.', 140),
					tool(
						'e6',
						at(360),
						'file_linear_issue',
						'title: "Q3 summary: receipts missing for 2 trips"',
						true,
						'Filed PER-212.',
						1_120
					),
					tool(
						'e7',
						at(400),
						'send_file',
						'projects/finance/q3-summary.pdf',
						true,
						'Sent q3-summary.pdf.',
						760
					),
					{
						type: 'assistant',
						id: 'e8',
						at: at(420),
						text: 'The **Q3 summary** is ready:\n\n- Total spend: $4,812, down 9% on Q2\n- 2 receipts are missing (Sep 3, Sep 18); I filed PER-212 to chase them\n\nThe PDF is in the chat.'
					}
				],
				evidence: {
					checks: [{ command: 'cd projects/finance && bun test', ok: true, at: at(300) }],
					changedRepos: ['finance'],
					checkAfterLastChange: true,
					verifyNudged: false,
					filesSent: [{ name: 'q3-summary.pdf', at: at(400) }],
					memoryWrites: [{ path: '~/memory/finance.md', tool: 'edit', at: at(330) }]
				},
				approvals: [
					{ nonce: 'n-linear-issue', at: at(358), tool: 'file_linear_issue', decision: 'approve' }
				],
				files: [q3Pdf],
				historyFile: `${run.startedAt.slice(0, 7)}/${run.startedAt.slice(8, 10)}-${run.runId}.md`
			};
		case RUNS.flights:
			return {
				...base(run),
				parent: runs.find((r) => r.runId === run.parentRunId),
				steps: [
					{
						type: 'user',
						id: 'f0',
						at: at(0),
						text: 'Compare round-trip prices SFO to Lisbon, Oct 12 to 26, on 4 airlines.'
					},
					tool(
						'f1',
						at(20),
						'fetch_url',
						'https://www.example-air.test/search?from=SFO&to=LIS&out=2026-10-12&back=2026-10-26&adults=2&cabin=economy&flex=3',
						true,
						'200 OK, 3 fares from $812',
						14_220
					),
					tool(
						'f2',
						at(400),
						'fetch_url',
						'https://www.example-two.test/flights/SFO-LIS',
						true,
						'200 OK, 2 fares from $790',
						21_040
					),
					tool('f3', at(900), 'fetch_url', 'https://www.example-three.test/booking', null, ''),
					{
						type: 'note',
						id: 'f4',
						at: at(1800),
						kind: 'aborted',
						text: 'Timed out after 30 minutes.'
					}
				],
				evidence: {
					checks: [],
					changedRepos: [],
					checkAfterLastChange: null,
					verifyNudged: false,
					filesSent: [],
					memoryWrites: []
				}
			};
		case RUNS.refactor:
			return {
				...base(run),
				steps: longSteps(run),
				evidence: {
					checks: [
						{
							command: 'bun run check && bunx playwright test e2e/app.test.ts',
							ok: false,
							at: at(588)
						},
						{
							command: 'bun run check && bunx playwright test e2e/app.test.ts',
							ok: true,
							at: at(4508)
						}
					],
					changedRepos: ['sushii-agent'],
					checkAfterLastChange: false,
					verifyNudged: true,
					filesSent: [],
					memoryWrites: [
						{ path: '~/memory/projects/sushii-agent.md', tool: 'edit', at: at(4520) },
						{
							path: '~/memory/notes/web-shell-layout-decisions-and-the-reasons-for-each.md',
							tool: 'write',
							at: at(4530)
						}
					]
				}
			};
		case RUNS.flush:
			return { ...base(run), session: 'missing' };
		case RUNS.rotate:
			return { ...base(run), session: 'not-session' };
		default:
			return {
				...base(run),
				steps: [
					{ type: 'user', id: 'x0', at: at(0), text: run.title },
					{ type: 'assistant', id: 'x1', at: at(30), text: run.resultSummary ?? 'Done.' }
				]
			};
	}
}

/** One page of a run's detail; evidence only on the first page, as the server sends it. */
export function runDetailPage(now: number, runId: string, after?: string): RunDetail | null {
	const full = runDetailFull(now, runId);
	if (!full) return null;
	const start = after ? Number(after) : 0;
	const steps = full.steps.slice(start, start + STEP_PAGE);
	const next = start + STEP_PAGE < full.steps.length ? String(start + STEP_PAGE) : null;
	return { ...full, steps, after: next, evidence: start ? undefined : full.evidence };
}
