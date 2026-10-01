// M2/M3 flows: the real Home, More, Runs and History screens on their feature fixtures, in every
// state a route can put them in.
import { allOn, moreFor } from '$lib/core/nav/nav';
import {
	HistoryDayScreen,
	HistoryScreen,
	SearchScreen,
	type SearchResult
} from '$lib/features/history';
import * as hf from '$lib/features/history/fixtures';
import { HomeScreen, type HomeGroups, type HomeItem, type HomePeek } from '$lib/features/home';
import * as h from '$lib/features/home/fixtures';
import { MoreScreen } from '$lib/features/more';
import { RunDetailScreen, RunListScreen } from '$lib/features/runs';
import * as r from '$lib/features/runs/fixtures';
import { toDate } from '$lib/ui/format/time';
import type { Flow, Frame } from './flows';

/** Every frame is drawn at this moment, so relative times never drift. */
const NOW = new Date(2026, 8, 30, 16, 41).getTime();
const TODAY = toDate(NOW);
const YESTERDAY = toDate(NOW - 86_400_000);

const more = moreFor(allOn);
/** Production before any fixture slice ships: only what the bot lists in /api/me. */
const liveOnly = (f?: string) => !f || ['runs', 'history', 'home', 'alerts'].includes(f);
const ready = { status: 'ready' } as const;
const slow = { status: 'loading', slow: true } as const;
const failed = (error: string) => ({ status: 'error', error }) as const;
const back = (href: string) => ({ href, label: 'Back' });

const groups = h.busyGroups(NOW);
const all = Object.values(groups).flat();
const item = (id: string) => all.find((i) => i.id === id) as HomeItem;
const peekOf = (id: string, extra: Partial<HomePeek> = {}): HomePeek => ({
	id,
	item: item(id),
	...extra
});
const home = (props: Record<string, unknown> = {}) => ({
	groups,
	remote: ready,
	now: NOW,
	...props
});
const waitingOnly: HomeGroups = { ...h.noGroups(), waiting: groups.waiting };
const shell = { shell: true, tabBar: true, tab: 'home', badges: { home: 2 } } as const;
const detail = (tab: string) => ({ shell: true, tab }) as const;

const runs = r.runSummaries(NOW);
const run = (id: string, after?: string) => r.runDetailPage(NOW, id, after);
const full = (id: string) => r.runDetailFull(NOW, id);
const runProps = (id: string, props: Record<string, unknown> = {}) => {
	const d = run(id);
	return {
		remote: ready,
		detail: d,
		now: NOW,
		back: back('/runs'),
		hasMore: !!d?.after,
		...props
	};
};

const search = (
	query: string,
	result: SearchResult | null = hf.searchFixtures(NOW, query),
	extra = {}
) => ({
	query,
	status: 'ready',
	result,
	now: NOW,
	back: back('/history'),
	...extra
});

const homeFrames: Frame[] = [
	{
		id: 'hm-1',
		label: 'Home: every group',
		screen: HomeScreen,
		props: home(),
		...shell,
		next: 'Tap the approval',
		hits: {
			'approve send_email': 'hm-2',
			'which day': 'hm-5',
			'nightly-sync': 'hm-6',
			'compare flight': 'hm-7',
			'main chat': 'hm-8',
			'draft the quarterly': 'hm-9'
		}
	},
	{
		id: 'hm-2',
		label: 'Approval peek: the real tray, held for 1s',
		screen: HomeScreen,
		props: home({ peek: peekOf(`approval:${h.emailApproval.nonce}`) }),
		...shell,
		next: 'Approve',
		hits: { approve: 'hm-3' }
	},
	{
		id: 'hm-3',
		label: 'Sending the decision',
		screen: HomeScreen,
		props: home({ peek: peekOf(`approval:${h.emailApproval.nonce}`, { submitting: true }) }),
		...shell,
		next: 'Bot confirms'
	},
	{
		id: 'hm-4',
		label: 'Decided; the item leaves Home',
		screen: HomeScreen,
		props: home({
			groups: { ...groups, waiting: groups.waiting.filter((i) => i.kind !== 'approval') },
			peek: {
				id: `approval:${h.emailApproval.nonce}`,
				result: { ok: true, text: 'Approved. The agent carries on.' }
			}
		}),
		...shell,
		badges: { home: 1 },
		hits: { close: 'hm-1' }
	},
	{
		id: 'hm-4b',
		label: 'A decision that did not send',
		screen: HomeScreen,
		props: home({
			peek: peekOf(`approval:${h.emailApproval.nonce}`, {
				result: {
					ok: false,
					text: "Couldn't send your decision. Check your connection and try again."
				}
			})
		}),
		...shell,
		branch: 'Send fails'
	},
	{
		id: 'hm-5',
		label: 'A question, answered from the sheet',
		screen: HomeScreen,
		props: home({ peek: peekOf(`ask:${h.serviceAsk.askId}`) }),
		...shell,
		branch: 'Tap the question'
	},
	{
		id: 'hm-6',
		label: 'A failed scheduled job',
		screen: HomeScreen,
		props: home({ peek: peekOf('job:nightly-sync') }),
		...shell,
		branch: 'Tap the failed job',
		hits: { 'open run': 'rd-3', 'ask the agent': 'ch-1', dismiss: 'hm-1' }
	},
	{
		id: 'hm-7',
		label: 'A failed background run',
		screen: HomeScreen,
		props: home({ peek: peekOf(`run:${h.RUN_IDS.flights}`) }),
		...shell,
		branch: 'Tap the failed run',
		hits: { 'open run': 'rd-1' }
	},
	{
		id: 'hm-8',
		label: 'Main is working',
		screen: HomeScreen,
		props: home({ peek: peekOf('turn:turn-1') }),
		...shell,
		branch: 'Tap the running chat',
		hits: { 'open chat': 'ch-1' }
	},
	{
		id: 'hm-9',
		label: 'Ready for review',
		screen: HomeScreen,
		props: home({ peek: peekOf(`run:${h.RUN_IDS.expenses}`) }),
		...shell,
		branch: 'Tap a finished run; opening it clears it',
		hits: { 'open run': 'rd-1' }
	},
	{
		id: 'hm-10',
		label: 'Nothing needs you',
		screen: HomeScreen,
		props: home({ groups: h.noGroups(), onopenchat: () => {} }),
		...shell,
		badges: {},
		branch: 'A quiet day'
	},
	{
		id: 'hm-11',
		label: 'Loading, slowly',
		screen: HomeScreen,
		props: home({ groups: h.noGroups(), remote: slow }),
		...shell,
		badges: {},
		branch: 'Cold start, slow network'
	},
	{
		id: 'hm-12',
		label: 'Waiting items while the rest loads',
		screen: HomeScreen,
		props: home({ groups: waitingOnly, partLoading: true }),
		...shell,
		branch: 'Stream first, server part slow'
	},
	{
		id: 'hm-13',
		label: 'Server part failed; approvals stay',
		screen: HomeScreen,
		props: home({ groups: waitingOnly, partError: "The agent's server didn't answer." }),
		...shell,
		branch: 'Server part fails'
	},
	{
		id: 'hm-14',
		label: 'The agent is unreachable',
		screen: HomeScreen,
		props: home({ groups: waitingOnly, workspace: 'offline' }),
		...shell,
		branch: 'Workspace offline'
	},
	{
		id: 'hm-15',
		label: 'Offline: what was loaded stays',
		screen: HomeScreen,
		props: home({ connection: { kind: 'app-offline' } }),
		...shell,
		branch: 'Phone offline'
	},
	{
		id: 'hm-16',
		label: "Couldn't load at all",
		screen: HomeScreen,
		props: home({ groups: h.noGroups(), remote: failed("The agent's server didn't answer.") }),
		...shell,
		badges: {},
		branch: 'Nothing loaded'
	},
	{
		id: 'hm-17',
		label: 'Push for something already handled',
		screen: HomeScreen,
		props: home({ peek: { id: 'approval:gone', missing: 'handled' } }),
		...shell,
		branch: 'Cold open of /?approve=<handled>'
	},
	{
		id: 'hm-18',
		label: "Push while offline: can't check",
		screen: HomeScreen,
		props: home({
			groups: h.noGroups(),
			connection: { kind: 'app-offline' },
			peek: { id: 'ask:x', missing: 'offline' }
		}),
		...shell,
		badges: {},
		branch: 'Cold open with no connection'
	},
	{
		id: 'hm-d',
		label: 'Desktop: list with the slim sidebar',
		screen: HomeScreen,
		props: home({ peek: peekOf('job:nightly-sync') }),
		shell: true,
		tab: 'home',
		badges: { home: 2 },
		desktop: true
	}
];

const moreFrames: Frame[] = [
	{
		id: 'mo-1',
		label: 'More',
		screen: MoreScreen,
		props: { entries: more },
		shell: true,
		tabBar: true,
		tab: 'more',
		hits: { runs: 'rl-1', history: 'hs-1' }
	},
	{
		id: 'mo-2',
		label: 'Offline',
		screen: MoreScreen,
		props: { entries: more, online: false },
		shell: true,
		tabBar: true,
		tab: 'more',
		branch: 'Phone offline'
	},
	{
		id: 'mo-3',
		label: 'Only what is live',
		screen: MoreScreen,
		props: { entries: moreFor(liveOnly) },
		shell: true,
		tabBar: true,
		tab: 'more',
		features: liveOnly,
		branch: 'Production, before the fixture screens get a backend: one Chat, no Chats list'
	},
	{
		id: 'mo-d',
		label: 'Desktop: every section sits under More',
		screen: MoreScreen,
		props: { entries: more },
		shell: true,
		tab: 'more',
		desktop: true
	}
];

const listProps = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	runs: runs.slice(0, 10),
	now: NOW,
	back: back('/more'),
	hasOlder: true,
	...props
});

const runListFrames: Frame[] = [
	{
		id: 'rl-1',
		label: 'Runs by day',
		screen: RunListScreen,
		props: listProps(),
		...detail('runs'),
		next: 'Show older runs',
		hits: { 'show older': 'rl-2' }
	},
	{
		id: 'rl-2',
		label: 'Oldest reached: the rest is in History',
		screen: RunListScreen,
		props: listProps({ runs, hasOlder: false, truncated: true }),
		...detail('runs'),
		scrollTo: 2000
	},
	{
		id: 'rl-3',
		label: 'Loading, slowly',
		screen: RunListScreen,
		props: listProps({ remote: slow, runs: [] }),
		...detail('runs'),
		branch: 'Slow network'
	},
	{
		id: 'rl-4',
		label: 'No runs yet',
		screen: RunListScreen,
		props: listProps({ runs: [], hasOlder: false }),
		...detail('runs'),
		branch: 'Fresh agent'
	},
	{
		id: 'rl-5',
		label: 'Runs not available yet',
		screen: RunListScreen,
		props: listProps({ remote: failed("Runs aren't available yet."), runs: [] }),
		...detail('runs'),
		branch: 'Bot without the runs feature'
	},
	{
		id: 'rl-6',
		label: 'Offline',
		screen: RunListScreen,
		props: listProps({ online: false }),
		...detail('runs'),
		branch: 'Phone offline'
	},
	{
		id: 'rl-d',
		label: 'Desktop',
		screen: RunListScreen,
		props: listProps(),
		...detail('runs'),
		desktop: true
	}
];

const nightly = full(r.RUNS.nightlySync)!;
const failedStep = nightly.steps.find((s) => s.type === 'tool' && s.ok === false)!.id;
const refactor = run(r.RUNS.refactor)!;

const runDetailFrames: Frame[] = [
	{
		id: 'rd-1',
		label: 'Finished: host status, evidence, timeline',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.expenses),
		...detail('runs'),
		next: 'Scroll',
		hits: { 'compare flight': 'rd-1b' }
	},
	{
		id: 'rd-1b',
		label: 'Timed out, started by another run',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.flights),
		...detail('runs')
	},
	{
		id: 'rd-2',
		label: 'Running',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.triage),
		...detail('runs'),
		branch: 'A run still going'
	},
	{
		id: 'rd-3',
		label: 'Failed, with the failing step open',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.nightlySync, { openSteps: [failedStep] }),
		...detail('runs'),
		branch: 'A failed job'
	},
	{
		id: 'rd-4',
		label: 'Long: 100 steps, then Show more',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.refactor, { steps: refactor.steps }),
		...detail('runs'),
		scrollTo: 100_000,
		branch: 'A 162-step run'
	},
	{
		id: 'rd-5',
		label: 'No transcript',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.flush),
		...detail('runs'),
		branch: 'Transcript gone'
	},
	{
		id: 'rd-6',
		label: 'Run not found',
		screen: RunDetailScreen,
		props: runProps('01K6AAAAAAAAAAAAAAAAAAAAAA', { detail: null }),
		...detail('runs'),
		branch: 'Cold link to an unknown run'
	},
	{
		id: 'rd-7',
		label: 'Loading, slowly',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.expenses, { remote: slow, detail: undefined }),
		...detail('runs'),
		branch: 'Slow network'
	},
	{
		id: 'rd-8',
		label: "Couldn't load",
		screen: RunDetailScreen,
		props: runProps(r.RUNS.expenses, {
			remote: failed("Can't reach the agent right now."),
			detail: undefined
		}),
		...detail('runs'),
		branch: 'Agent unreachable'
	},
	{
		id: 'rd-d',
		label: 'Desktop',
		screen: RunDetailScreen,
		props: runProps(r.RUNS.expenses),
		...detail('runs'),
		desktop: true
	}
];

const dayProps = (date: string, props: Record<string, unknown> = {}) => ({
	date,
	remote: ready,
	detail: hf.historyDay(NOW, date),
	now: NOW,
	back: back('/history'),
	...props
});
const daysProps = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	days: hf.historyDays(NOW).slice(0, 10),
	now: NOW,
	back: back('/more'),
	hasOlder: true,
	...props
});

const historyFrames: Frame[] = [
	{
		id: 'hs-1',
		label: 'Days, newest first',
		screen: HistoryScreen,
		props: daysProps(),
		...detail('history'),
		next: 'Open today',
		hits: { today: 'hs-2', search: 'sr-1' }
	},
	{
		id: 'hs-2',
		label: "Today: the agent's notes and runs",
		screen: HistoryDayScreen,
		props: dayProps(TODAY),
		...detail('history')
	},
	{
		id: 'hs-3',
		label: 'Notes cut off at the read cap',
		screen: HistoryDayScreen,
		props: dayProps(YESTERDAY),
		...detail('history'),
		branch: 'A very long day'
	},
	{
		id: 'hs-4',
		label: 'No notes for this day',
		screen: HistoryDayScreen,
		props: dayProps('2019-01-01'),
		...detail('history'),
		branch: 'A day with nothing kept'
	},
	{
		id: 'hs-5',
		label: 'No notes yet',
		screen: HistoryScreen,
		props: daysProps({ days: [], hasOlder: false }),
		...detail('history'),
		branch: 'Fresh agent'
	},
	{
		id: 'hs-6',
		label: 'Loading, slowly',
		screen: HistoryScreen,
		props: daysProps({ remote: slow, days: [] }),
		...detail('history'),
		branch: 'Slow network'
	},
	{
		id: 'hs-7',
		label: "Couldn't load",
		screen: HistoryScreen,
		props: daysProps({ remote: failed("History isn't available yet."), days: [] }),
		...detail('history'),
		branch: 'Bot without the history feature'
	},
	{
		id: 'hs-d',
		label: 'Desktop: a day',
		screen: HistoryDayScreen,
		props: dayProps(TODAY),
		...detail('history'),
		desktop: true
	}
];

const searchFrames: Frame[] = [
	{
		id: 'sr-1',
		label: 'Search, before typing',
		screen: SearchScreen,
		props: search('', null, { status: 'idle' }),
		...detail('history'),
		keyboard: ['east', 'eastside', 'easy'],
		next: 'Type "eastside"'
	},
	{
		id: 'sr-2',
		label: 'Hits from chat and notes',
		screen: SearchScreen,
		props: search('eastside'),
		...detail('history'),
		hits: { 'day notes': 'hs-2' }
	},
	{
		id: 'sr-3',
		label: 'No results',
		screen: SearchScreen,
		props: search('zebra crossing'),
		...detail('history'),
		branch: 'Nothing matches'
	},
	{
		id: 'sr-4',
		label: 'Stopped early',
		screen: SearchScreen,
		props: search('eastside', { ...hf.searchFixtures(NOW, 'eastside'), truncated: true }),
		...detail('history'),
		branch: 'A cap was hit'
	},
	{
		id: 'sr-5',
		label: 'Notes could not be searched',
		screen: SearchScreen,
		props: search('eastside', {
			...hf.searchFixtures(NOW, 'eastside'),
			hits: hf.searchFixtures(NOW, 'eastside').hits.filter((x) => x.source === 'chat'),
			unavailable: ['notes']
		}),
		...detail('history'),
		branch: 'Workspace offline'
	},
	{
		id: 'sr-6',
		label: 'Searching, slowly',
		screen: SearchScreen,
		props: search('eastside', null, { status: 'loading', slow: true }),
		...detail('history'),
		branch: 'Slow search'
	},
	{
		id: 'sr-7',
		label: "Couldn't search",
		screen: SearchScreen,
		props: search('eastside', null, {
			status: 'error',
			error: "The agent's server didn't answer."
		}),
		...detail('history'),
		branch: 'Search fails'
	}
];

export const m23Flows: Flow[] = [
	{
		id: 'home',
		code: 'HM',
		title: 'Home: needs you',
		intro:
			'Grouped by what blocks progress: waiting on you, failed, running, ready for review. Every row opens a peek sheet. Approvals peek with the same tray as the chat, held for 1s; questions with the same ask card. Failed jobs and runs peek as the agent’s own records, with Open run and Dismiss.',
		frames: homeFrames
	},
	{
		id: 'more',
		code: 'MO',
		title: 'More',
		intro:
			'Three tabs: Home, Chat (Chats once threads exist) and More. More lists every section that is on; the desktop sidebar has the same entries. A section shows only when its feature is on, so production shows what is live and the board shows everything.',
		frames: moreFrames
	},
	{
		id: 'runs',
		code: 'RL',
		title: 'Runs',
		intro:
			'Every chat turn, scheduled job and background run, by day, with the status the host recorded.',
		frames: runListFrames
	},
	{
		id: 'run',
		code: 'RD',
		title: 'Run detail',
		intro:
			'The outcome as the host recorded it, never a green tick: "done" means it finished, not that it worked. Evidence lists checks, changed code, files sent and memory writes. Tool steps start collapsed; file paths are text.',
		frames: runDetailFrames
	},
	{
		id: 'history',
		code: 'HS',
		title: 'History',
		intro:
			"A day list, then each day's session recaps (the agent's own notes, as markdown) and the runs that started that day.",
		frames: historyFrames
	},
	{
		id: 'search',
		code: 'SR',
		title: 'Search chat and notes',
		intro:
			'One search over the chat the bot stores and the agent’s notes. Each hit says where it came from; matches are highlighted.',
		frames: searchFrames
	}
];

/** Hrefs inside these screens, mapped to the frame they land on. */
export const m23Routes: [string, string][] = [
	['/', 'hm-1'],
	['/more', 'mo-1'],
	['/chat', 'ch-1'],
	[`/runs/${r.RUNS.nightlySync}`, 'rd-3'],
	[`/runs/${r.RUNS.triage}`, 'rd-2'],
	[`/runs/${r.RUNS.refactor}`, 'rd-4'],
	[`/runs/${r.RUNS.flush}`, 'rd-5'],
	[`/runs/${r.RUNS.flights}`, 'rd-1b'],
	['/runs/*', 'rd-1'],
	['/runs', 'rl-1'],
	['/history/search*', 'sr-2'],
	[`/history/${YESTERDAY}`, 'hs-3'],
	['/history/*', 'hs-2'],
	['/history', 'hs-1']
];
