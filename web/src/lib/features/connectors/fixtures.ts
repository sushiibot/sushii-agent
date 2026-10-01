// Typed fixtures for connectors, shared by the fake API, the prototype board and tests. Made up.
import type { McpServer } from './types';

const DAY = 86_400_000;
const iso = (now: number, daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

export function servers(now: number): McpServer[] {
	return [
		{
			id: 'code-host',
			name: 'Code host',
			url: 'https://mcp.code-host.example/mcp',
			status: 'connected',
			tools: 5,
			changed: true,
			snapshotAt: iso(now, 47),
			toolList: [
				{ name: 'get_pull_request', description: 'Read a pull request and its diff' },
				{ name: 'list_pull_requests', description: 'List pull requests by repo and state' },
				{ name: 'create_review', description: 'Submit a review' },
				{ name: 'merge_pull_request', description: 'Merge a pull request', change: 'added' },
				{ name: 'search_code', description: 'Search code across repos' },
				{ name: 'delete_branch', description: 'Delete a branch', change: 'removed' }
			],
			history: [
				{
					at: iso(now, 3),
					event: 'Tool list changed: merge_pull_request added, delete_branch removed'
				},
				{ at: iso(now, 28), event: 'Token refreshed' },
				{ at: iso(now, 47), event: 'Connected with OAuth. Snapshot of 5 tools saved.' }
			],
			usedBy: [
				{
					runId: '01K6AZT2V4X6Z8B0D2F4H6K8M0',
					title: 'Split the web shell into a layout and per-screen headers',
					tool: 'get_pull_request',
					at: iso(now, 0.3)
				}
			]
		},
		{
			id: 'mail',
			name: 'Mail',
			url: 'https://mcp.mail.example/sse',
			status: 'connected',
			tools: 4,
			changed: false,
			snapshotAt: iso(now, 12),
			toolList: [
				{ name: 'search_mail', description: 'Search messages' },
				{ name: 'read_message', description: 'Read one message' },
				{ name: 'draft_reply', description: 'Write a draft reply' },
				{ name: 'send_message', description: 'Send a message' }
			],
			history: [{ at: iso(now, 12), event: 'Connected with OAuth. Snapshot of 4 tools saved.' }],
			usedBy: [
				{
					runId: '01K6B4A0C2E4G6J8M0P2R4T6V8',
					title: "What's the invoice from Eastside Auto about?",
					tool: 'search_mail',
					at: iso(now, 0.07)
				}
			]
		},
		{
			id: 'calendar',
			name: 'Calendar',
			url: 'https://mcp.calendar.example/mcp',
			status: 'signed-out',
			problem: 'The sign-in expired. Sign in again to use it.',
			tools: 3,
			changed: false,
			snapshotAt: iso(now, 60),
			toolList: [
				{ name: 'list_events', description: 'List events in a range' },
				{ name: 'create_event', description: 'Create an event' },
				{ name: 'find_free_time', description: 'Find free slots' }
			],
			history: [
				{ at: iso(now, 1), event: 'Sign-in expired' },
				{ at: iso(now, 60), event: 'Connected with OAuth. Snapshot of 3 tools saved.' }
			],
			usedBy: []
		}
	];
}

/** What a server added by URL turns into once connected. */
export function newServer(now: number, url: string, name: string): McpServer {
	return {
		id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
		name,
		url,
		status: 'connected',
		tools: 6,
		changed: false,
		snapshotAt: new Date(now).toISOString(),
		toolList: [
			{ name: 'list_issues', description: 'Search and filter issues' },
			{ name: 'get_issue', description: 'Read one issue with comments' },
			{ name: 'create_issue', description: 'Create an issue' },
			{ name: 'update_issue', description: 'Change state, assignee, labels' },
			{ name: 'list_projects', description: 'List projects' },
			{ name: 'add_comment', description: 'Comment on an issue' }
		],
		history: [
			{ at: new Date(now).toISOString(), event: 'Connected with OAuth. Snapshot of 6 tools saved.' }
		],
		usedBy: []
	};
}
