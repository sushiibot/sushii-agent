import type { Component } from 'svelte';
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
}

export interface Flow {
	id: string;
	code: string;
	title: string;
	intro: string;
	frames: Frame[];
}

const hvacRun = '/runs/run-hvac';

export const flows: Flow[] = [
	{
		id: 'needs-you',
		code: 'NY',
		title: 'Needs-you home',
		intro:
			'Grouped by what blocks progress, not by time. Failed runs sit with the things that need you. Tap an item to peek and reply without opening the chat.',
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
				label: 'Peek and reply',
				screen: NeedsYou,
				props: { items: f.inbox, peek: 'in-flight', draft: '24C please' },
				next: 'Send reply',
				hits: { 'send reply': 'ny-3' }
			},
			{
				id: 'ny-3',
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
		id: 'chat',
		code: 'CH',
		title: 'Chat turn with approval',
		intro:
			'The agent drafts an email. The approval card shows exactly what will go out, your edits as a diff, and proof it was sent.',
		frames: [
			{
				id: 'ch-1',
				label: 'Drafting',
				screen: Chat,
				props: { messages: f.chatMessages, draft: f.hvacDraft, stage: 'drafting' },
				next: 'Draft ready'
			},
			{
				id: 'ch-2',
				label: 'Approval card',
				screen: Chat,
				props: { messages: f.chatMessages, draft: f.hvacDraft, stage: 'approval' },
				next: 'Edit',
				hits: { 'approve and send': 'ch-5', edit: 'ch-3', deny: 'ch-6' }
			},
			{
				id: 'ch-3',
				label: 'Editing the body',
				screen: Chat,
				props: { messages: f.chatMessages, draft: f.hvacEdited, stage: 'editing' },
				next: 'Save',
				hits: { 'save and review': 'ch-4', 'cancel edit': 'ch-2' }
			},
			{
				id: 'ch-4',
				label: 'Review your edits',
				screen: Chat,
				props: { messages: f.chatMessages, draft: f.hvacEdited, stage: 'edited' },
				next: 'Approve',
				hits: { 'approve and send': 'ch-5', edit: 'ch-3', deny: 'ch-6' }
			},
			{
				id: 'ch-5',
				label: 'Sent, with evidence',
				screen: Chat,
				props: {
					messages: f.chatMessages,
					draft: f.hvacEdited,
					stage: 'sent',
					messageId: '<c81f02.4b@home.example>',
					runHref: hvacRun
				}
			},
			{
				id: 'ch-6',
				label: 'Denied',
				screen: Chat,
				props: { messages: f.chatMessages, draft: f.hvacDraft, stage: 'denied' },
				branch: 'Deny from CH-2 or CH-4'
			},
			{
				id: 'ch-d',
				label: 'Desktop: approval card',
				screen: Chat,
				props: { messages: f.chatMessages, draft: f.hvacEdited, stage: 'edited' },
				desktop: true,
				hits: { 'approve and send': 'ch-5', edit: 'ch-3', deny: 'ch-6' }
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
			'Every memory write is a commit with its diff, the run that made it, and whether that run had read outside content. Skills show their stage and why.',
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
				label: 'Reverted',
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
				id: 'ms-d',
				label: 'Desktop: timeline and diff',
				screen: Memory,
				props: { changes: f.memoryChanges, selected: 'mc1' },
				desktop: true,
				hits: { 'revert this change': 'ms-3' }
			},
			{
				id: 'ms-d2',
				label: 'Desktop: draft skill',
				screen: Skills,
				props: { skills: f.skills, selected: 'rent-receipts' },
				desktop: true
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
				id: 'sc-d',
				label: 'Desktop: a quiet job',
				screen: Schedules,
				props: { jobs: f.jobs, selected: 'inbox' },
				desktop: true,
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
				id: 'mc-d',
				label: 'Desktop: tool list changed since last snapshot',
				screen: McpServer,
				props: { server: f.github },
				desktop: true
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
			},
			{
				id: 'br-d',
				label: 'Desktop',
				screen: Briefing,
				props: { items: f.brief, votes: { b2: 'up' } },
				desktop: true
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
			},
			{ id: 'hs-d', label: 'Desktop', screen: History, props: { days: f.days }, desktop: true }
		]
	}
];

// First match wins; a trailing * matches by prefix.
export const routes: [string, string][] = [
	['/', 'ny-1'],
	['/chat*', 'ch-1'],
	['/runs/run-deps', 'rd-2'],
	['/runs*', 'rd-1'],
	['/memory/skills', 'ms-4'],
	['/memory/skills/deploy-relay-bot', 'ms-5'],
	['/memory/skills/*', 'ms-d2'],
	['/memory/*', 'ms-2'],
	['/memory', 'ms-1'],
	['/schedules/deps', 'sc-2'],
	['/schedules/*', 'sc-d'],
	['/schedules', 'sc-1'],
	['/connectors/linear', 'mc-5'],
	['/connectors/*', 'mc-d'],
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
