import type { Component } from 'svelte';
import type { Session } from '$lib/agent/types';
import NeedsYou from '$lib/agent/screens/needs-you.svelte';
import Chat from '$lib/agent/screens/chat.svelte';
import RunDetail from '$lib/agent/screens/run-detail.svelte';
import Memory from '$lib/agent/screens/memory.svelte';
import Skills from '$lib/agent/screens/skills.svelte';
import Schedules from '$lib/agent/screens/schedules.svelte';
import Connectors from '$lib/agent/screens/connectors.svelte';
import McpServer from '$lib/agent/screens/mcp-server.svelte';
import Briefing from '$lib/agent/screens/briefing.svelte';
import History from '$lib/agent/screens/history.svelte';
import RunFile from '$lib/agent/screens/run-file.svelte';
import Chats from '$lib/agent/screens/chats.svelte';
import More from '$lib/agent/screens/more.svelte';
import Workbench from '$lib/agent/screens/workbench.svelte';
import HomeScreen from './components/home-screen.svelte';
import * as f from './fixtures';

export interface Frame {
	id: string;
	label: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	screen: Component<any>;
	props: Record<string, unknown>;
	/** Label on the arrow into the next frame of the row. */
	next?: string;
	/** In-screen button text (prefix, case-insensitive) → target frame id. */
	hits?: Record<string, string>;
	/** Rendered in a branch row under the main row instead of inline. */
	branch?: string;
	desktop?: boolean;
	/** Phone chrome: the installed app (default), a Safari tab, or the bare OS. */
	chrome?: 'standalone' | 'safari' | 'bare';
	/** Show the on-screen keyboard, with these predictions above it. */
	keyboard?: string[];
	alert?: 'push';
}

export interface Flow {
	id: string;
	code: string;
	title: string;
	intro: string;
	frames: Frame[];
}

const hvacRun = '/runs/run-hvac';
const archivedTrip: Session = { ...f.tripSession, state: 'archived' };

export const flows: Flow[] = [
	{
		id: 'install',
		code: 'IN',
		title: 'Install and first launch',
		intro:
			'iOS has no install prompt, so a Safari tab shows a quiet hint. The installed app opens full screen. Notifications are asked for only when you tap, never on launch.',
		frames: [
			{
				id: 'in-1',
				label: 'In a Safari tab',
				screen: NeedsYou,
				props: { items: f.inbox, hint: 'install' },
				chrome: 'safari',
				next: 'Share → Add to Home Screen'
			},
			{
				id: 'in-2',
				label: 'Home screen',
				screen: HomeScreen,
				props: {},
				chrome: 'bare',
				next: 'Open',
				hits: { agent: 'in-3' }
			},
			{
				id: 'in-3',
				label: 'First launch, installed',
				screen: NeedsYou,
				props: { items: f.inbox, hint: 'push' },
				next: 'Tap Turn on',
				hits: { 'turn on notifications': 'in-4' }
			},
			{
				id: 'in-4',
				label: 'System ask, after the tap',
				screen: NeedsYou,
				props: { items: f.inbox, hint: 'push' },
				alert: 'push',
				next: 'Allow'
			},
			{
				id: 'in-5',
				label: 'Notifications on',
				screen: NeedsYou,
				props: {
					items: f.inbox,
					toast: 'Notifications on. Only approvals, questions and failures.'
				}
			}
		]
	},
	{
		id: 'needs-you',
		code: 'NY',
		title: 'Home: needs you',
		intro:
			'Grouped by what blocks progress, not by time. Failed runs come second. Tap an item to peek and reply in a sheet without opening the chat.',
		frames: [
			{
				id: 'ny-1',
				label: 'Home',
				screen: NeedsYou,
				props: { items: f.inbox },
				next: 'Tap an item',
				hits: { 'pick a seat': 'ny-2' }
			},
			{
				id: 'ny-2',
				label: 'Peek in a sheet',
				screen: NeedsYou,
				props: { items: f.inbox, peek: 'in-flight' },
				next: 'Type a reply'
			},
			{
				id: 'ny-3',
				label: 'Replying: the sheet rides the keyboard',
				screen: NeedsYou,
				props: { items: f.inbox, peek: 'in-flight', draft: '24C please' },
				keyboard: ['24C', 'please', 'thanks'],
				next: 'Send reply',
				hits: { 'send reply': 'ny-4' }
			},
			{
				id: 'ny-4',
				label: 'Run resumes',
				screen: NeedsYou,
				props: {
					items: f.replySent,
					notice: 'Reply sent. The seat pick is running again with 24C.'
				}
			},
			{
				id: 'ny-d',
				label: 'Desktop: list and peek side by side',
				screen: NeedsYou,
				props: { items: f.inbox, peek: 'in-lease' },
				desktop: true
			}
		]
	},
	{
		id: 'chats',
		code: 'CS',
		title: 'Chats: Main and threads',
		intro:
			'One agent, one memory, separate conversations. Main is pinned and is where threads report back. Threads are grouped by what they need from you, and idle ones archive themselves.',
		frames: [
			{
				id: 'cs-1',
				label: 'Chats',
				screen: Chats,
				props: { sessions: f.sessions, archivedOpen: true },
				next: 'Search'
			},
			{
				id: 'cs-2',
				label: 'Typing: the tab bar hides',
				screen: Chats,
				props: { sessions: f.sessions, query: 'trip' },
				keyboard: ['trip', 'trips', 'trip’s']
			},
			{
				id: 'cs-d',
				label: 'Desktop: Main and a thread side by side',
				screen: Workbench,
				props: {
					panes: [
						{ session: f.mainSession, messages: f.tripMainAccepted },
						{ session: f.tripSession, messages: f.tripThread }
					]
				},
				desktop: true
			}
		]
	},
	{
		id: 'more',
		code: 'NV',
		title: 'Tabs and More',
		intro:
			'Four tabs: Home, Chats, Briefing, More. The tab bar shows only on those four screens. Everything opened from them gets a back button and no tab bar, and the tab bar hides while the keyboard is up.',
		frames: [{ id: 'nv-1', label: 'More', screen: More, props: {} }]
	},
	{
		id: 'thread',
		code: 'TH',
		title: 'Main suggests a thread',
		intro:
			'When a topic keeps coming back, Main offers to move it. The thread starts from a brief, not the whole history, and shares memory with Main.',
		frames: [
			{
				id: 'th-1',
				label: 'Main offers a thread',
				screen: Chat,
				props: { session: f.mainSession, messages: f.tripMain },
				next: 'Start thread',
				hits: { 'start thread': 'th-2' }
			},
			{
				id: 'th-2',
				label: 'Thread opens with a brief',
				screen: Chat,
				props: { session: f.tripSession, messages: f.tripThreadNew },
				next: 'Chat in the thread'
			},
			{
				id: 'th-3',
				label: 'Working in the thread',
				screen: Chat,
				props: { session: f.tripSession, messages: f.tripThread, writes: f.tripWrites },
				next: 'Tap “shares memory”',
				hits: { 'shares memory': 'th-4', close: 'cl-1' }
			},
			{
				id: 'th-4',
				label: 'Writes from this thread',
				screen: Chat,
				props: {
					session: f.tripSession,
					messages: f.tripThread,
					writes: f.tripWrites,
					sheet: 'memory'
				}
			},
			{
				id: 'th-5',
				label: 'Typing in a thread',
				screen: Chat,
				props: {
					session: f.tripSession,
					messages: f.tripThread,
					writes: f.tripWrites,
					typing: 'Is breakfast included at Kawabune?'
				},
				keyboard: ['Kawabune', 'Kawabune?', 'Kawa'],
				branch: 'Keyboard up'
			},
			{
				id: 'th-6',
				label: 'Long-press any message',
				screen: Chat,
				props: { session: f.mainSession, messages: f.tripMain, sheet: 'actions', pressed: 't2' },
				branch: 'Or branch from a message',
				hits: { 'branch into a thread': 'th-2', 'ask on the side': 'th-7' }
			},
			{
				id: 'th-7',
				label: 'Ask on the side',
				screen: Chat,
				props: { session: f.mainSession, messages: f.tripMain, sheet: 'aside', aside: f.tripAside },
				branch: 'A quick question that stays out of the chat',
				hits: { done: 'th-1' }
			}
		]
	},
	{
		id: 'close',
		code: 'CL',
		title: 'Close a thread',
		intro:
			'Closing shows what gets kept in memory and the one line Main will get. The thread is archived, not deleted.',
		frames: [
			{
				id: 'cl-1',
				label: 'Summary before closing',
				screen: Chat,
				props: {
					session: f.tripSession,
					messages: f.tripThread,
					writes: f.tripWrites,
					sheet: 'close',
					closing: f.tripClose
				},
				next: 'Close thread',
				hits: { 'close thread': 'cl-2', 'keep open': 'th-3' }
			},
			{
				id: 'cl-2',
				label: 'Main gets a one-line report',
				screen: Chat,
				props: { session: f.mainSession, messages: f.tripMainReported },
				next: 'Open the report'
			},
			{
				id: 'cl-3',
				label: 'Archived thread',
				screen: Chat,
				props: {
					session: archivedTrip,
					messages: f.tripThread,
					writes: f.tripWrites,
					archived: 'Oct 1'
				}
			}
		]
	},
	{
		id: 'chat',
		code: 'CH',
		title: 'Chat turn with approval',
		intro:
			'The agent drafts an email. The card shows exactly what goes out, your edits as a diff, and proof it was sent. While it waits you can still type below the approve bar.',
		frames: [
			{
				id: 'ch-1',
				label: 'Drafting',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.chatMessages,
					approval: { draft: f.hvacDraft, stage: 'drafting' }
				},
				next: 'Draft ready'
			},
			{
				id: 'ch-2',
				label: 'Approval card',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.chatMessages,
					approval: { draft: f.hvacDraft, stage: 'approval' }
				},
				next: 'Edit',
				hits: { 'approve and send': 'ch-5', edit: 'ch-3', deny: 'ch-6' }
			},
			{
				id: 'ch-3',
				label: 'Editing the body',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.chatMessages,
					approval: { draft: f.hvacEdited, stage: 'editing' }
				},
				next: 'Save',
				hits: { 'save and review': 'ch-4', 'cancel edit': 'ch-2' }
			},
			{
				id: 'ch-4',
				label: 'Review your edits',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.chatMessages,
					approval: { draft: f.hvacEdited, stage: 'edited' }
				},
				next: 'Approve',
				hits: { 'approve and send': 'ch-5', edit: 'ch-3', deny: 'ch-6' }
			},
			{
				id: 'ch-5',
				label: 'Sent, with evidence',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.chatMessages,
					waiting: 1,
					approval: {
						draft: f.hvacEdited,
						stage: 'sent',
						messageId: '<c81f02.4b@home.example>',
						runHref: hvacRun
					}
				}
			},
			{
				id: 'ch-6',
				label: 'Denied',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.chatMessages,
					waiting: 1,
					approval: { draft: f.hvacDraft, stage: 'denied' }
				},
				branch: 'Deny from CH-2 or CH-4'
			}
		]
	},
	{
		id: 'runs',
		code: 'RD',
		title: 'Run detail',
		intro:
			'One line per tool call, with the evidence the agent collected. A run that finished without proof is marked unverified, not green.',
		frames: [
			{
				id: 'rd-1',
				label: 'Verified run',
				screen: RunDetail,
				props: { run: f.runs['run-hvac'], open: ['s4'] },
				next: 'Compare'
			},
			{
				id: 'rd-2',
				label: 'Finished but unverified',
				screen: RunDetail,
				props: { run: f.runs['run-deps'], open: ['d3'] }
			},
			{
				id: 'rd-d',
				label: 'Desktop: timeline with outcome rail',
				screen: RunDetail,
				props: { run: f.runs['run-hvac'], open: ['s1'] },
				desktop: true
			}
		]
	},
	{
		id: 'memory',
		code: 'MS',
		title: 'Memory and skill timeline',
		intro:
			'Every memory write is a commit with its diff, the run and thread that made it, and whether that run had read outside content. Revert is one tap, with Restore in the toast.',
		frames: [
			{
				id: 'ms-1',
				label: 'Change timeline',
				screen: Memory,
				props: { changes: f.memoryChanges },
				next: 'Open a change'
			},
			{
				id: 'ms-2',
				label: 'Tainted change',
				screen: Memory,
				props: { changes: f.memoryChanges, selected: 'mc1' },
				next: 'Revert',
				hits: { 'revert this change': 'ms-3' }
			},
			{
				id: 'ms-3',
				label: 'Reverted, with Restore',
				screen: Memory,
				props: { changes: f.memoryChanges, selected: 'mc1', reverted: true },
				next: 'Skills tab',
				hits: { restore: 'ms-2' }
			},
			{
				id: 'ms-4',
				label: 'Skills',
				screen: Skills,
				props: { skills: f.skills },
				next: 'Open a skill'
			},
			{
				id: 'ms-5',
				label: 'Skill inspector',
				screen: Skills,
				props: { skills: f.skills, selected: 'deploy-relay-bot' }
			},
			{
				id: 'ms-6',
				label: 'Draft skill',
				screen: Skills,
				props: { skills: f.skills, selected: 'rent-receipts' },
				branch: 'A skill still in draft'
			},
			{
				id: 'ms-d',
				label: 'Desktop: timeline and diff',
				screen: Memory,
				props: { changes: f.memoryChanges, selected: 'mc1' },
				desktop: true,
				hits: { 'revert this change': 'ms-3' }
			}
		]
	},
	{
		id: 'schedules',
		code: 'SC',
		title: 'Schedules',
		intro:
			'Each job says why its last run was quiet: nothing new, suppressed, skipped, outside hours or failed. Test-run a job before trusting it.',
		frames: [
			{
				id: 'sc-1',
				label: 'Jobs with failure alert',
				screen: Schedules,
				props: { jobs: f.jobs },
				next: 'Fix and test'
			},
			{
				id: 'sc-2',
				label: 'Job detail',
				screen: Schedules,
				props: { jobs: f.jobs, selected: 'deps' },
				next: 'Test run',
				hits: { 'test run': 'sc-3' }
			},
			{
				id: 'sc-3',
				label: 'Test running',
				screen: Schedules,
				props: { jobs: f.jobs, selected: 'deps', test: 'running' },
				next: 'Finishes'
			},
			{
				id: 'sc-4',
				label: 'Test passed',
				screen: Schedules,
				props: { jobs: f.jobs, selected: 'deps', test: 'done' },
				hits: { 'test again': 'sc-3' }
			},
			{
				id: 'sc-5',
				label: 'A quiet job',
				screen: Schedules,
				props: { jobs: f.jobs, selected: 'inbox' },
				branch: 'Why a job said nothing',
				hits: { 'test run': 'sc-3' }
			}
		]
	},
	{
		id: 'connectors',
		code: 'MC',
		title: 'Add an MCP server',
		intro:
			'The agent runs on a server, so OAuth ends on a localhost page that fails to load. You paste that address back and the agent finishes the exchange.',
		frames: [
			{
				id: 'mc-1',
				label: 'Connectors',
				screen: Connectors,
				props: { servers: [f.github] },
				next: 'Add server',
				hits: { 'add mcp server': 'mc-2' }
			},
			{
				id: 'mc-2',
				label: 'Paste URL',
				screen: Connectors,
				props: { servers: [], stage: 'url', url: 'https://mcp.linear.example/sse' },
				next: 'Continue',
				hits: { continue: 'mc-3' }
			},
			{
				id: 'mc-3',
				label: 'OAuth link',
				screen: Connectors,
				props: { servers: [], stage: 'oauth' },
				next: 'Signed in',
				hits: { "i've signed in": 'mc-4' }
			},
			{
				id: 'mc-4',
				label: 'Paste redirect URL',
				screen: Connectors,
				props: {
					servers: [],
					stage: 'paste',
					redirect: 'http://localhost:7461/callback?code=lin_8f2Kq0x&state=q8Zt2'
				},
				next: 'Connect',
				hits: { connect: 'mc-5' }
			},
			{
				id: 'mc-5',
				label: 'Connected, tools snapshot',
				screen: McpServer,
				props: { server: f.linear, justConnected: true }
			},
			{
				id: 'mc-6',
				label: 'Tool list changed',
				screen: McpServer,
				props: { server: f.github },
				branch: 'A server changed its tools since the last snapshot'
			}
		]
	},
	{
		id: 'brief',
		code: 'BR',
		title: 'Morning briefing',
		intro:
			'Delivered to Discord at 07:30. Here each item has its source, a dismiss, and a vote that tunes tomorrow’s ranking.',
		frames: [
			{
				id: 'br-1',
				label: 'Briefing',
				screen: Briefing,
				props: { items: f.brief },
				next: 'Rate and dismiss'
			},
			{
				id: 'br-2',
				label: 'After feedback',
				screen: Briefing,
				props: { items: f.brief, dismissed: ['b5'], votes: { b2: 'up', b3: 'up', b4: 'down' } }
			}
		]
	},
	{
		id: 'history',
		code: 'HS',
		title: 'History search',
		intro:
			'Search across chats and runs. Each day has a summary, its sessions and its runs, and every run has a plain file.',
		frames: [
			{
				id: 'hs-1',
				label: 'Recent days',
				screen: History,
				props: { days: f.days },
				next: 'Search'
			},
			{
				id: 'hs-2',
				label: 'Search results',
				screen: History,
				props: { days: f.days, query: 'maple' },
				next: 'Open a run'
			},
			{
				id: 'hs-3',
				label: 'Run file',
				screen: RunFile,
				props: { path: f.runs['run-hvac'].file, content: f.runFile, runId: 'run-hvac' }
			}
		]
	}
];

// First match wins; a trailing * matches by prefix.
export const routes: [string, string][] = [
	['/', 'ny-1'],
	['/chats/main', 'cl-2'],
	['/chats/oct-trip-archived', 'cl-3'],
	['/chats/oct-trip', 'th-3'],
	['/chats', 'cs-1'],
	['/more', 'nv-1'],
	['/runs/run-deps', 'rd-2'],
	['/runs*', 'rd-1'],
	['/memory/skills', 'ms-4'],
	['/memory/skills/deploy-relay-bot', 'ms-5'],
	['/memory/skills/*', 'ms-6'],
	['/memory/mc1', 'ms-2'],
	['/memory/*', 'ms-1'],
	['/memory', 'ms-1'],
	['/schedules/deps', 'sc-2'],
	['/schedules/*', 'sc-5'],
	['/schedules', 'sc-1'],
	['/connectors/linear', 'mc-5'],
	['/connectors/*', 'mc-6'],
	['/connectors', 'mc-1'],
	['/brief', 'br-1'],
	['/history/*', 'hs-3'],
	['/history', 'hs-1']
];

export function frameFor(path: string): string | undefined {
	return routes.find(([p]) =>
		p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p
	)?.[1];
}
