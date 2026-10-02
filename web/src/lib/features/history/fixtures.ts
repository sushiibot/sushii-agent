// Typed fixtures for History, shared by the fake API, the prototype board and tests. Dates and
// times are relative to `now`; run ids match the Runs fixtures, so a day's runs open there.
import type { RunSummary } from '$lib/features/runs';
import { toDate } from '../../ui/format/time';
import { findRanges } from './highlight';
import type { ChatHit, HistoryDay, HistoryDayDetail, NotesHit, SearchResult } from './types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (now: number, minsAgo: number) => new Date(now - minsAgo * MIN).toISOString();
const dateAgo = (now: number, days: number) => toDate(now - days * DAY);

export function historyDays(now: number): HistoryDay[] {
	const counts = [
		[3, 9],
		[2, 4],
		[1, 3],
		[0, 2],
		[2, 6],
		[1, 1],
		[3, 7],
		[1, 2],
		[2, 5],
		[1, 3],
		[0, 1],
		[2, 4]
	];
	return counts.map(([sessions, runs], i) => ({
		date: dateAgo(now, i),
		sessions,
		runs,
		cost: {
			usd: i === 3 ? 0 : 0.18 + runs * 0.04,
			recordedRuns: i === 3 ? 0 : runs - (i === 1 ? 1 : 0),
			unpricedRuns: i === 3 ? runs : i === 1 ? 1 : 0
		}
	}));
}

const recapToday = `Read **invoice #1042** from Eastside Auto ($412.60, due on the 14th) and checked it against the quote from August.

- The amounts match.
- drk approved scheduling the payment for the 12th.
- Sent the reply to Sam once drk approved it.

Open: confirm the payment cleared on the 13th.`;

const recapExpenses = `Drafted the Q3 expenses summary in \`projects/finance/q3-summary.md\`.

1. Total spend $4,812, down 9% on Q2.
2. Two receipts are missing (Sep 3, Sep 18); filed PER-212.

A planted image stays text: ![chart](/f/AbCdEfGhIjKlMnOpQrStUv) and so does <b>raw html</b>.`;

const recapYesterday = `Weekly dependency check found 3 updates, none of them security fixes. Summarised the HOA meeting: the dues go up $15 in January, and the pool closes on Oct 15.`;

function dayRuns(now: number): RunSummary[] {
	return [
		{
			runId: '01K6B2N8W3J5Q7R9T1V3X5Z7A9',
			kind: 'job',
			agentName: 'main',
			jobName: 'nightly-sync',
			title: 'Back up projects to the home server',
			status: 'failed',
			startedAt: iso(now, 11),
			endedAt: iso(now, 10)
		},
		{
			runId: '01K6B3A1C3E5G7J9M1P3R5T7V9',
			kind: 'subagent',
			agentName: 'writer',
			title: 'Draft the quarterly expenses summary',
			status: 'done',
			startedAt: iso(now, 95),
			endedAt: iso(now, 50)
		},
		{
			runId: '01K6B4A0C2E4G6J8M0P2R4T6V8',
			kind: 'chat',
			agentName: 'main',
			title: "What's the invoice from Eastside Auto about?",
			status: 'done',
			startedAt: iso(now, 100),
			endedAt: iso(now, 99)
		}
	];
}

export function historyDay(now: number, date: string): HistoryDayDetail {
	const days = historyDays(now);
	if (!days.some((d) => d.date === date)) return { found: false };
	if (date === dateAgo(now, 0)) {
		return {
			found: true,
			date,
			cost: days.find((d) => d.date === date)?.cost,
			sessions: [
				{ heading: 'Invoice from Eastside Auto', markdown: recapToday },
				{ heading: 'Quarterly expenses', markdown: recapExpenses },
				{ heading: 'Morning brief', markdown: 'Three meetings today; nothing needs prep.' }
			],
			runs: dayRuns(now),
			truncated: false
		};
	}
	if (date === dateAgo(now, 1)) {
		return {
			found: true,
			date,
			cost: days.find((d) => d.date === date)?.cost,
			sessions: [{ heading: 'Dependencies and the HOA notes', markdown: recapYesterday }],
			runs: [
				{
					runId: '01K6AZ8B0D2F4H6K8M0P2R4T6V',
					kind: 'job',
					agentName: 'main',
					jobName: 'weekly-deps',
					title: 'Check dependencies for updates',
					status: 'done',
					startedAt: iso(now, 26 * 60),
					endedAt: iso(now, 26 * 60 - 4)
				}
			],
			truncated: true
		};
	}
	if (date === dateAgo(now, 3)) {
		return { found: true, date, sessions: [], runs: [], truncated: false };
	}
	return {
		found: true,
		date,
		sessions: [{ heading: 'A quiet day', markdown: 'Ran the scheduled jobs. Nothing needed you.' }],
		runs: [],
		truncated: false
	};
}

interface Line {
	text: string;
}

/** What search runs over: chat the bot stores, and lines of the agent's notes. */
function corpus(now: number): ((ChatHit | NotesHit) & Line)[] {
	const chat = (id: string, minsAgo: number, role: 'user' | 'agent', text: string) => ({
		source: 'chat' as const,
		id,
		at: iso(now, minsAgo),
		role,
		snippet: text,
		ranges: [],
		text
	});
	const note = (
		id: string,
		daysAgo: number,
		text: string,
		extra: Partial<NotesHit> = {}
	): NotesHit & Line => ({
		source: 'notes',
		id,
		kind: 'daily',
		date: dateAgo(now, daysAgo),
		line: Number(id.split(':')[1] ?? 1),
		snippet: text,
		ranges: [],
		text,
		...extra
	});
	return [
		chat('m1', 101, 'user', "What's the invoice from Eastside Auto about?"),
		chat(
			'm2',
			100,
			'agent',
			'Invoice #1042 from Eastside Auto is $412.60, due on the 14th. It matches the quote.'
		),
		chat('m3', 60 * 27, 'user', '🚗 Book the car service at Eastside Auto for Friday morning'),
		chat('m4', 60 * 50, 'agent', 'The HOA dues go up $15 in January; the pool closes on Oct 15.'),
		note(
			`${dateAgo(now, 0)}.md:12`,
			0,
			'Read invoice #1042 from Eastside Auto ($412.60, due on the 14th).',
			{
				heading: 'Invoice from Eastside Auto'
			}
		),
		note(
			`${dateAgo(now, 0).slice(0, 7)}/${dateAgo(now, 0).slice(8)}-01K6B3A1C3E5G7J9M1P3R5T7V9.md:40`,
			0,
			'Two receipts are missing for the invoice reconciliation (Sep 3, Sep 18); filed PER-212.',
			{
				kind: 'run',
				runId: '01K6B3A1C3E5G7J9M1P3R5T7V9',
				heading: 'Result'
			}
		),
		note(
			`${dateAgo(now, 6)}.md:8`,
			6,
			'Paid the Eastside Auto invoice for the brake job; receipt saved to projects/finance/receipts.',
			{
				heading: 'Car'
			}
		),
		note(`${dateAgo(now, 9)}.md:3`, 9, 'Asked Eastside Auto for a quote on the 60k-mile service.', {
			heading: 'Car'
		})
	];
}

const SNIPPET_MAX = 240;

function clip(text: string, first: number): { snippet: string; offset: number } {
	const cps = Array.from(text);
	if (cps.length <= SNIPPET_MAX) return { snippet: text, offset: 0 };
	const start = Math.max(0, Math.min(first - 60, cps.length - SNIPPET_MAX));
	return { snippet: cps.slice(start, start + SNIPPET_MAX).join(''), offset: start };
}

export function searchFixtures(now: number, query: string, limit = 20): SearchResult {
	const hits = corpus(now).flatMap((line) => {
		const ranges = findRanges(line.text, query);
		if (!ranges.length) return [];
		const { snippet, offset } = clip(line.text, ranges[0][0]);
		const { text: _text, ...hit } = line;
		void _text;
		return [
			{
				...hit,
				snippet,
				ranges: ranges.map(([s, e]) => [s - offset, e - offset] as [number, number])
			}
		];
	});
	const time = (h: ChatHit | NotesHit) => (h.source === 'chat' ? h.at : `${h.date}T23:59:59Z`);
	hits.sort((a, b) => time(b).localeCompare(time(a)));
	return {
		query,
		hits: hits.slice(0, limit),
		truncated: hits.length > limit,
		unavailable: []
	};
}
