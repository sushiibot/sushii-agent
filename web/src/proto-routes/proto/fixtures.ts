import type {
	AskView,
	FileRef,
	PendingApproval,
	PhotoDraft,
	Turn,
	MemoryWrite,
	Session,
	ThreadClose,
	BriefItem,
	ChatMessage,
	DaySummary,
	InboxItem,
	Job,
	McpServer,
	MemoryChange,
	Run,
	Skill
} from '$lib/agent/types';

// Every person, company, address and id below is invented.

export const inbox: InboxItem[] = [
	{
		id: 'in-lease',
		state: 'waiting',
		title: 'Reply to Maple Row about the HVAC visit',
		source: 'Chat',
		when: '4 min ago',
		summary: 'Draft reply to Dana Whitfield is ready. Sending email needs your approval.',
		question: 'Send this reply to dana@maplerow-pm.example?',
		runId: 'run-hvac',
		tainted: true,
		kind: 'approval',
		href: '/chats/main?approve=ap-hvac'
	},
	{
		id: 'in-deps-pr',
		state: 'waiting',
		title: 'Open a PR on acme/notify-service',
		source: 'Chat',
		when: '12 min ago',
		summary: 'Bumps 3 dependencies. Opening a pull request needs your approval.',
		question: 'Run github_create_pr on acme/notify-service?',
		runId: 'run-deps',
		kind: 'approval',
		href: '/chats/main?approve=ap-pr'
	},
	{
		id: 'in-flight',
		state: 'waiting',
		title: 'Pick a seat for FA 107 to Haneda',
		source: 'Chat',
		when: '38 min ago',
		summary: 'Check-in opens at 10:40. Two aisle seats left in the forward cabin.',
		question: 'Aisle 24C or window 31K?',
		runId: 'run-checkin',
		kind: 'ask',
		href: '/chats/main?ask=seat-107'
	},
	{
		id: 'in-deploy-fail',
		state: 'failed',
		title: 'Weekly dependency sweep failed',
		source: 'Schedule · Tuesdays 07:00',
		when: '2 h ago',
		summary: 'bun install hit a 403 from the registry mirror on notify-service. No PR opened.',
		runId: 'run-deps'
	},
	{
		id: 'in-pr',
		state: 'running',
		title: 'Reviewing notify-service #212',
		source: 'Chat',
		when: 'started 6 min ago',
		summary: 'Reading 14 changed files. Step 5 of about 9.',
		runId: 'run-pr'
	},
	{
		id: 'in-rent',
		state: 'review',
		title: 'October rent receipt filed',
		source: 'Schedule · 1st of month',
		when: '09:12',
		summary: 'Saved the receipt to finance/2026-10.md and matched it to the bank entry.',
		runId: 'run-rent'
	},
	{
		id: 'in-bot',
		state: 'review',
		title: 'relay-bot 4.18.2 is live on green',
		source: 'Chat',
		when: 'Yesterday',
		summary: 'Switched traffic, error rate flat for 30 min, blue drained.',
		runId: 'run-deploy'
	}
];

export const hvacDraft = {
	from: 'sam@home.example',
	to: 'Dana Whitfield <dana@maplerow-pm.example>',
	subject: 'Re: HVAC maintenance, Unit 4B',
	inReplyTo: {
		from: 'Dana Whitfield',
		excerpt:
			'Our technician can service the unit on Thursday Oct 2 between 8am and 12pm. Please confirm access, and let us know if the parking permit for the van should go to the front desk.'
	},
	body: `Hi Dana,

Thursday works. Any time after 10am is fine, and I'll leave the side gate unlocked.

Please send the permit to the front desk. Is there anything I should move away from the unit before the visit?

Thanks,
Sam`
};

export const runs: Record<string, Run> = {
	'run-hvac': {
		id: 'run-hvac',
		title: 'Reply to Maple Row about the HVAC visit',
		trigger: 'Chat · Discord DM',
		started: 'Sep 29, 14:02',
		duration: '1m 48s',
		cost: '$0.031',
		model: 'claude-sonnet-5',
		state: 'done',
		outcome: 'verified',
		outcomeNote: 'Sent message found in the Sent folder with the expected Message-ID.',
		tainted: {
			by: 'read_email · thread from maplerow-pm.example',
			locked: ['bash', 'memory_write', 'web_fetch']
		},
		steps: [
			{
				id: 's1',
				name: 'read_email',
				summary: 'Searched "from:maplerow-pm.example HVAC"',
				at: '14:02:05',
				ms: 820,
				status: 'ok',
				detail: '1 thread, 1 message. Subject "HVAC maintenance, Unit 4B".',
				taints: true
			},
			{
				id: 's2',
				name: 'calendar_list',
				summary: 'Checked Thu Oct 2, 08:00–12:00',
				at: '14:02:07',
				ms: 410,
				status: 'ok',
				detail: 'Free after 09:30. "Standup" 09:00–09:30.'
			},
			{
				id: 's3',
				name: 'draft_email',
				summary: 'Drafted reply to Dana Whitfield',
				at: '14:02:19',
				ms: 2300,
				status: 'ok'
			},
			{
				id: 's4',
				name: 'send_email',
				summary: 'Waited 1m 12s for approval, then sent',
				at: '14:03:31',
				ms: 1150,
				status: 'approved',
				detail: 'Approved by you after 1 edit.'
			},
			{
				id: 's5',
				name: 'read_email',
				summary: 'Read back the Sent folder',
				at: '14:03:34',
				ms: 540,
				status: 'ok',
				detail: 'Matched Message-ID <c81f02.4b@home.example>.'
			}
		],
		evidence: [
			{ kind: 'message-id', label: 'Message-ID', value: '<c81f02.4b@home.example>' },
			{ kind: 'readback', label: 'Sent folder readback', value: 'Found, 14:03:34' },
			{ kind: 'file', label: 'Run file', value: 'runs/2026-09-29/hvac-reply.md' }
		],
		file: 'runs/2026-09-29/hvac-reply.md'
	},
	'run-deps': {
		id: 'run-deps',
		title: 'Weekly dependency sweep',
		trigger: 'Schedule · Tuesdays 07:00',
		started: 'Sep 29, 07:00',
		duration: '4m 12s',
		cost: '$0.084',
		model: 'claude-sonnet-5',
		state: 'failed',
		outcome: 'unverified',
		outcomeNote: 'The run exited cleanly, but no PR exists and no branch was pushed.',
		steps: [
			{
				id: 'd1',
				name: 'git_clone',
				summary: 'Cloned acme/notify-service',
				at: '07:00:04',
				ms: 3100,
				status: 'ok'
			},
			{
				id: 'd2',
				name: 'bash',
				summary: 'bun outdated',
				at: '07:00:09',
				ms: 5200,
				status: 'ok',
				detail: '6 packages behind, 1 major (discord.js 15).'
			},
			{
				id: 'd3',
				name: 'bash',
				summary: 'bun update --latest (5 minor)',
				at: '07:00:31',
				ms: 61000,
				status: 'error',
				detail: 'error: GET https://registry.mirror.example/@discordjs%2frest - 403 Forbidden'
			},
			{
				id: 'd4',
				name: 'bash',
				summary: 'Retried with the public registry',
				at: '07:02:10',
				ms: 58000,
				status: 'error',
				detail: 'Same 403. bunfig.toml pins the mirror.'
			},
			{
				id: 'd5',
				name: 'reply',
				summary: 'Posted "No changes today"',
				at: '07:04:12',
				ms: 300,
				status: 'ok',
				detail: 'The summary says nothing about the 403.'
			}
		],
		evidence: [],
		file: 'runs/2026-09-29/deps-sweep.md'
	}
};

export const memoryChanges: MemoryChange[] = [
	{
		id: 'mc5',
		file: 'travel/2026-10-tokyo.md',
		summary: 'Hotel shortlist near Kuramae, with cancellation dates',
		when: '12 min ago',
		commit: 'a51c0e2',
		run: { id: 'run-trip-hotels', title: 'Compare Kuramae hotels' },
		session: { id: 'oct-trip', title: 'October trip' },
		diff: [
			{ kind: 'add', text: '## Hotels (Oct 9–16, under ¥25k)' },
			{ kind: 'add', text: '- Ryokan Asagi ¥24.5k, breakfast, free cancel until Oct 6' },
			{ kind: 'add', text: '- Kawabune Inn ¥19k, free cancel until Oct 7' }
		]
	},
	{
		id: 'mc1',
		file: 'MEMORY.md',
		summary: 'Added: Maple Row prefers email over phone for scheduling',
		when: 'Today 14:04',
		commit: '7f3c2a1',
		run: { id: 'run-hvac', title: 'Reply to Maple Row about the HVAC visit' },
		taint: 'Read external email',
		diff: [
			{ kind: 'ctx', text: '## Home' },
			{ kind: 'ctx', text: '- Unit 4B, lease renews 2027-03-01.' },
			{
				kind: 'add',
				text: '- Maple Row (Dana Whitfield) prefers email for scheduling; replies within a day.'
			},
			{ kind: 'add', text: '- Maintenance visits: side gate code is 4417.' }
		]
	},
	{
		id: 'mc2',
		file: 'USER.md',
		summary: 'Changed: no meetings before 10am on Thursdays',
		when: 'Today 14:03',
		commit: '1ab9e04',
		run: { id: 'run-hvac', title: 'Reply to Maple Row about the HVAC visit' },
		diff: [
			{ kind: 'ctx', text: '## Schedule' },
			{ kind: 'del', text: '- Avoid meetings before 09:30.' },
			{ kind: 'add', text: '- Avoid meetings before 09:30, and before 10:00 on Thursdays.' }
		]
	},
	{
		id: 'mc3',
		file: 'skills/deploy-relay-bot/SKILL.md',
		summary: 'Skill updated: wait 30 min before draining blue',
		when: 'Yesterday 21:40',
		commit: 'e04d7b9',
		run: { id: 'run-deploy', title: 'relay-bot 4.18.2 blue/green switch' },
		diff: [
			{ kind: 'ctx', text: '4. Switch traffic to green.' },
			{ kind: 'del', text: '5. Drain blue after 10 minutes.' },
			{ kind: 'add', text: '5. Watch error rate for 30 minutes, then drain blue.' }
		]
	},
	{
		id: 'mc4',
		file: 'memory/2026-09-28.md',
		summary: 'Daily note: flight to HND booked, seat not chosen',
		when: 'Yesterday 18:15',
		commit: 'c2290fe',
		run: { id: 'run-trip', title: 'Book October trip' },
		taint: 'Read external email',
		diff: [
			{ kind: 'add', text: '- Booked FA 107 SFO→HND, Oct 9, conf. QX7R2L.' },
			{ kind: 'add', text: '- Seat not chosen yet; check-in opens 24h before.' }
		]
	}
];

export const skills: Skill[] = [
	{
		name: 'deploy-relay-bot',
		description: 'Blue/green switch for relay-bot production with error-rate watch.',
		stage: 'active',
		uses: 23,
		successRate: 0.96,
		lastUsed: 'Yesterday',
		reason: 'Promoted after 5 runs in a row that ended with a verified health check.',
		history: [
			{
				when: 'Sep 28',
				event: 'Updated',
				reason: 'You corrected the drain delay in chat. Diff scan: clean.'
			},
			{ when: 'Sep 12', event: 'Promoted to active', reason: '5 verified runs in a row.' },
			{ when: 'Aug 30', event: 'Drafted', reason: 'Learned from a deploy you walked through.' }
		],
		runs: [
			{ id: 'run-deploy', title: 'relay-bot 4.18.2', ok: true, when: 'Yesterday' },
			{ id: 'r-417', title: 'relay-bot 4.17.0', ok: true, when: 'Sep 21' },
			{ id: 'r-416', title: 'relay-bot 4.16.3', ok: false, when: 'Sep 14' }
		]
	},
	{
		name: 'rent-receipts',
		description: 'File the monthly rent receipt and match it to the bank entry.',
		stage: 'draft',
		uses: 2,
		successRate: 1,
		lastUsed: 'Today',
		reason: 'Held as draft: needs 3 verified runs before it can load automatically.',
		history: [{ when: 'Sep 1', event: 'Drafted', reason: 'Written after a manual filing run.' }],
		runs: [{ id: 'run-rent', title: 'October rent', ok: true, when: 'Today' }]
	},
	{
		name: 'flight-checkin',
		description: 'Check in 24h before departure and save the boarding pass.',
		stage: 'stale',
		uses: 4,
		successRate: 0.75,
		lastUsed: 'Jun 3',
		reason: 'Marked stale: unused for 90 days and the airline site changed since.',
		history: [
			{ when: 'Sep 1', event: 'Marked stale', reason: 'No use in 90 days.' },
			{ when: 'Apr 2', event: 'Promoted to active', reason: '3 verified runs.' }
		],
		runs: [{ id: 'r-jun', title: 'Check in FA 837', ok: true, when: 'Jun 3' }]
	},
	{
		name: 'discord-mod-digest',
		description: 'Summarize mod cases across guilds each morning.',
		stage: 'archived',
		uses: 41,
		successRate: 0.9,
		lastUsed: 'Jul 14',
		reason: 'Archived when you deleted the morning mod digest schedule.',
		history: [{ when: 'Jul 14', event: 'Archived', reason: 'Its schedule was deleted.' }],
		runs: []
	}
];

export const jobs: Job[] = [
	{
		id: 'brief',
		name: 'Morning briefing',
		schedule: 'Daily 07:30',
		next: 'Tomorrow 07:30',
		enabled: true,
		last: { result: 'sent', when: 'Today 07:30', note: '5 items sent to Discord DM' },
		history: [
			{ when: 'Today 07:30', result: 'sent', note: '5 items' },
			{ when: 'Mon 07:30', result: 'sent', note: '3 items' },
			{ when: 'Sun 07:30', result: 'sent', note: '4 items' }
		]
	},
	{
		id: 'deps',
		name: 'Weekly dependency sweep',
		schedule: 'Tuesdays 07:00',
		next: 'Oct 6, 07:00',
		enabled: true,
		last: { result: 'failed', when: 'Today 07:00', note: 'Registry mirror returned 403' },
		history: [
			{ when: 'Today 07:00', result: 'failed', note: 'Registry mirror returned 403' },
			{ when: 'Sep 22', result: 'sent', note: 'Opened notify-service #208' },
			{ when: 'Sep 15', result: 'quiet', note: 'Everything up to date' }
		]
	},
	{
		id: 'inbox',
		name: 'Inbox watch',
		schedule: 'Every 30 min, 08:00–22:00',
		next: 'Today 15:00',
		enabled: true,
		last: { result: 'quiet', when: 'Today 14:30', note: '12 new, none needed you' },
		history: [
			{ when: 'Today 14:30', result: 'quiet', note: '12 new, none needed you' },
			{ when: 'Today 14:00', result: 'sent', note: 'Maple Row HVAC email flagged' },
			{ when: 'Today 13:30', result: 'suppressed', note: 'Same newsletter as 13:00' }
		]
	},
	{
		id: 'prs',
		name: 'PR review queue',
		schedule: 'Weekdays 09:00',
		next: 'Tomorrow 09:00',
		enabled: true,
		last: { result: 'suppressed', when: 'Today 09:00', note: 'Only your own PRs open' },
		history: [
			{ when: 'Today 09:00', result: 'suppressed', note: 'Only your own PRs open' },
			{ when: 'Mon 09:00', result: 'sent', note: '2 PRs waiting on you' }
		]
	},
	{
		id: 'heartbeat',
		name: 'Heartbeat',
		schedule: 'Hourly',
		next: 'Today 15:00',
		enabled: true,
		last: { result: 'outside-hours', when: 'Today 06:00', note: 'Active hours start at 08:00' },
		history: [
			{ when: 'Today 14:00', result: 'quiet', note: 'Nothing due' },
			{ when: 'Today 06:00', result: 'outside-hours', note: 'Active hours start at 08:00' }
		]
	},
	{
		id: 'backup',
		name: 'Home repo backup check',
		schedule: 'Sundays 20:00',
		next: 'Oct 4, 20:00',
		enabled: false,
		last: { result: 'skipped', when: 'Sun 20:00', note: 'Paused by you' },
		history: [{ when: 'Sun 20:00', result: 'skipped', note: 'Paused by you' }]
	}
];

export const linear: McpServer = {
	name: 'Linear',
	url: 'https://mcp.linear.example/sse',
	status: 'connected',
	connectedAt: 'Just now',
	tools: [
		{ name: 'list_issues', description: 'Search and filter issues' },
		{ name: 'get_issue', description: 'Read one issue with comments' },
		{ name: 'create_issue', description: 'Create an issue in a team' },
		{ name: 'update_issue', description: 'Change state, assignee, labels' },
		{ name: 'list_projects', description: 'List projects and milestones' },
		{ name: 'add_comment', description: 'Comment on an issue' }
	],
	history: [{ when: 'Just now', event: 'Connected with OAuth. Snapshot of 6 tools saved.' }],
	usedBy: []
};

export const github: McpServer = {
	name: 'GitHub',
	url: 'https://api.githubcopilot.example/mcp',
	status: 'connected',
	connectedAt: 'Aug 14',
	tools: [
		{ name: 'get_pull_request', description: 'Read a PR and its diff' },
		{ name: 'list_pull_requests', description: 'List PRs by repo and state' },
		{ name: 'create_review', description: 'Submit a PR review' },
		{ name: 'merge_pull_request', description: 'Merge a PR', change: 'added' },
		{ name: 'search_code', description: 'Search code across repos' },
		{ name: 'delete_branch', description: 'Delete a branch', change: 'removed' }
	],
	history: [
		{ when: 'Sep 27', event: 'Tool list changed: +merge_pull_request, −delete_branch' },
		{ when: 'Sep 2', event: 'Token refreshed' },
		{ when: 'Aug 14', event: 'Connected with OAuth. Snapshot of 5 tools saved.' }
	],
	usedBy: [
		{
			runId: 'run-pr',
			title: 'Reviewing notify-service #212',
			tool: 'get_pull_request',
			when: 'Now'
		},
		{ runId: 'r-208', title: 'Dependency sweep', tool: 'create_pull_request', when: 'Sep 22' }
	]
};

export const brief: BriefItem[] = [
	{
		id: 'b1',
		section: 'Top of mind',
		title: 'Maple Row wants to service the HVAC on Thursday',
		detail:
			'Dana offered Thu Oct 2, 8am to 12pm, and asked where the van permit goes. Not answered yet.',
		source: { label: 'Email · Maple Row', href: '/history' }
	},
	{
		id: 'b2',
		section: 'Top of mind',
		title: 'notify-service #212 is waiting on your review',
		detail: 'Rate-limit fix for the feed poller. CI green, 14 files, +212 −88.',
		source: { label: 'GitHub · acme/notify-service', href: '/runs/run-pr' }
	},
	{
		id: 'b3',
		section: 'Top of mind',
		title: 'Dependency sweep failed on a registry 403',
		detail: 'No PR this week. The bunfig mirror needs a new token.',
		source: { label: 'Run · deps sweep', href: '/runs/run-deps' }
	},
	{
		id: 'b4',
		section: 'Looking ahead',
		title: 'FA 107 to Haneda, Oct 9 at 11:05',
		detail: 'Check-in opens Oct 8 at 11:05. Seat not chosen.',
		source: { label: 'Email · Ferro Air itinerary', href: '/history' }
	},
	{
		id: 'b5',
		section: 'Looking ahead',
		title: 'Lease renewal notice due Dec 1',
		detail: 'Unit 4B renews Mar 1. Maple Row asks for 90 days notice either way.',
		source: { label: 'File · home/lease-4B.pdf', href: '/history' }
	}
];

export const days: DaySummary[] = [
	{
		date: 'Tue, Sep 29',
		summary:
			'Replied to Maple Row about the HVAC visit. Dependency sweep failed on a registry 403. Filed October rent.',
		sessions: [
			{ id: 'se1', title: 'HVAC reply to Dana', time: '14:01', messages: 6 },
			{ id: 'se2', title: 'Review notify-service #212', time: '14:20', messages: 3 }
		],
		runs: [
			{
				id: 'run-hvac',
				title: 'Reply to Maple Row',
				time: '14:02',
				state: 'done',
				outcome: 'verified'
			},
			{
				id: 'run-rent',
				title: 'October rent receipt',
				time: '09:12',
				state: 'review',
				outcome: 'verified'
			},
			{
				id: 'run-deps',
				title: 'Dependency sweep',
				time: '07:00',
				state: 'failed',
				outcome: 'unverified'
			}
		]
	},
	{
		date: 'Mon, Sep 28',
		summary: 'Booked FA 107 to Haneda. Deployed relay-bot 4.18.2 to green.',
		sessions: [
			{ id: 'se3', title: 'October trip planning', time: '17:40', messages: 22 },
			{ id: 'se4', title: 'Deploy relay-bot', time: '21:05', messages: 9 }
		],
		runs: [
			{
				id: 'run-trip',
				title: 'Book October trip',
				time: '18:02',
				state: 'done',
				outcome: 'verified'
			},
			{
				id: 'run-deploy',
				title: 'relay-bot 4.18.2',
				time: '21:10',
				state: 'done',
				outcome: 'verified'
			}
		]
	}
];

export const runFile = `# Reply to Maple Row about the HVAC visit

- run: run-hvac
- trigger: Discord DM
- started: 2026-09-29 14:02:03
- outcome: verified
- tainted: yes (read_email, maplerow-pm.example)

## Request
Reply to Dana about the HVAC visit. Thursday is fine but not before 10.

## Steps
1. read_email "from:maplerow-pm.example HVAC" → 1 thread
2. calendar_list Thu Oct 2 → free after 09:30
3. draft_email → approval requested
4. You edited line 3, approved
5. send_email → 250 OK
6. read_email Sent → Message-ID <c81f02.4b@home.example>

## Memory writes
- MEMORY.md +2 (Maple Row prefers email)
- USER.md ~1 (Thursdays after 10:00)
`;

export const sessions: Session[] = [
	{
		id: 'main',
		kind: 'main',
		title: 'Main',
		state: 'idle',
		lastActivity: '2 min ago',
		preview: 'While you were out: rent receipt filed, dependency sweep failed.',
		unread: 1
	},
	{
		id: 'oct-trip',
		kind: 'thread',
		title: 'October trip',
		state: 'needs-you',
		lastActivity: '38 min ago',
		preview: 'Aisle 24C or window 31K?'
	},
	{
		id: 'pr-212',
		kind: 'thread',
		title: 'notify-service #212 review',
		state: 'running',
		lastActivity: 'now',
		preview: 'Reading 14 changed files'
	},
	{
		id: 'lease',
		kind: 'thread',
		title: 'Lease renewal',
		state: 'idle',
		lastActivity: 'Yesterday',
		preview: 'Drafted the 90-day notice. Not sent.',
		unread: 2
	},
	{
		id: 'taxes',
		kind: 'thread',
		title: '2026 taxes',
		state: 'idle',
		lastActivity: 'Mon',
		preview: 'Collected 9 of 12 documents.'
	},
	{
		id: 'bike',
		kind: 'thread',
		title: 'Bike fitting',
		state: 'idle',
		lastActivity: 'Sep 24',
		preview: 'Booked Saturday 10:00 at Spoke & Gear.'
	},
	{
		id: 'couch',
		kind: 'thread',
		title: 'Couch delivery',
		state: 'archived',
		lastActivity: 'Sep 19',
		preview: 'Delivered Sep 12. Reported to Main.'
	},
	{
		id: 'passport',
		kind: 'thread',
		title: 'Passport renewal',
		state: 'archived',
		lastActivity: 'Sep 3',
		preview: 'New passport arrived. Reported to Main.'
	}
];

export const mainSession = sessions[0];
export const tripSession = sessions[1];

const tripOffer = {
	title: 'October trip',
	reason:
		'The trip came up in 9 of your last 14 messages. A thread keeps hotels, trains and bookings together and keeps Main short.'
};

export const tripMain: ChatMessage[] = [
	{
		id: 't0',
		role: 'assistant',
		parts: [
			{
				type: 'data-notice',
				data: {
					source: 'While you were out · 2 updates',
					items: ['Rent receipt filed', 'Dependency sweep failed'],
					href: '/'
				}
			}
		]
	},
	{
		id: 't1',
		role: 'user',
		parts: [{ type: 'text', text: 'Find hotels near Kuramae for Oct 9–16, under ¥25k a night.' }]
	},
	{
		id: 't2',
		role: 'assistant',
		parts: [
			{
				type: 'tool-search_web',
				toolCallId: 'tt1',
				state: 'output-available',
				input: { query: 'Kuramae hotels Oct 9-16 under 25000 yen' },
				output: { found: '12 results · 3 under budget' }
			},
			{
				type: 'text',
				text: 'Three fit: Kawabune Inn (¥19k), Hotel Sumida Loft (¥23k) and Ryokan Asagi (¥24.5k with breakfast). Want me to check cancellation terms?'
			}
		]
	},
	{
		id: 't3',
		role: 'user',
		parts: [{ type: 'text', text: 'Yes. And is the rail pass still worth it if we skip Osaka?' }]
	},
	{
		id: 't4',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: 'Without Osaka, single tickets come to about ¥14k less than the pass, so skip it.'
			},
			{ type: 'data-thread-offer', data: tripOffer }
		]
	}
];

export const tripMainAccepted: ChatMessage[] = tripMain.map((m) =>
	m.id === 't4'
		? {
				...m,
				parts: [
					m.parts[0],
					{ type: 'data-thread-offer', data: { ...tripOffer, openedAs: 'oct-trip' } }
				]
			}
		: m
);

export const tripWrites: MemoryWrite[] = [
	{
		id: 'mc5',
		file: 'travel/2026-10-tokyo.md',
		summary: 'Hotel shortlist near Kuramae, with cancellation dates',
		when: '12 min ago',
		session: { id: 'oct-trip', title: 'October trip' }
	},
	{
		id: 'mc6',
		file: 'USER.md',
		summary: 'Prefers an aisle seat on flights over 6 hours',
		when: '4 min ago',
		session: { id: 'oct-trip', title: 'October trip' }
	}
];

const tripBrief: ChatMessage = {
	id: 'b0',
	role: 'assistant',
	parts: [
		{
			type: 'data-thread-brief',
			data: {
				known: [
					'Flight FA 107 SFO→HND on Oct 9 is booked. Seat not picked.',
					'Tokyo Oct 9–16, hotel under ¥25k a night.',
					'Skipping Osaka, so no rail pass.'
				],
				open: [
					'Which of the three Kuramae hotels',
					'Cancellation terms for each',
					'Seat: aisle 24C or window 31K'
				],
				recentFromMain: 6
			}
		},
		{
			type: 'text',
			text: 'Picking up the trip here. Main stays for everything else. Where do you want to start?'
		}
	]
};

export const tripThreadNew: ChatMessage[] = [tripBrief];

export const tripThread: ChatMessage[] = [
	tripBrief,
	{
		id: 'b1',
		role: 'user',
		parts: [
			{ type: 'text', text: 'Check cancellation for Asagi and Kawabune. Aisle seat, always.' }
		]
	},
	{
		id: 'b2',
		role: 'assistant',
		parts: [
			{
				type: 'tool-read_page',
				toolCallId: 'tb1',
				state: 'output-available',
				input: { url: 'https://asagi-ryokan.example/policies' },
				output: { found: 'Free cancellation until Oct 6' }
			},
			{
				type: 'text',
				text: 'Asagi is free to cancel until Oct 6, Kawabune until Oct 7. I saved both, and noted aisle seats for long flights.'
			},
			{ type: 'data-memory-write', data: tripWrites[0] },
			{ type: 'data-memory-write', data: tripWrites[1] }
		]
	}
];

export const tripClose: ThreadClose = {
	writes: [
		...tripWrites,
		{
			id: 'mc7',
			file: 'travel/2026-10-tokyo.md',
			summary: 'Trip summary: what is booked and what is still open',
			when: 'on close',
			session: { id: 'oct-trip', title: 'October trip' }
		}
	],
	report: {
		sessionId: 'oct-trip-archived',
		title: 'October trip',
		line: 'Flight FA 107 booked, seat 24C. Hotel still open: Asagi or Kawabune, free to cancel until Oct 6.'
	}
};

export const tripMainReported: ChatMessage[] = [
	...tripMainAccepted,
	{
		id: 't5',
		role: 'assistant',
		parts: [{ type: 'data-thread-report', data: tripClose.report }]
	}
];

export const tripAside = {
	question: 'What time is it in Tokyo right now?',
	answer: "It's 1:41 on Wednesday morning there, 16 hours ahead of you."
};

// M1 chat fixtures. Photos are inline SVG so the board needs no network.
function photo(a: number, b: number): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="oklch(0.78 0.09 ${a})"/><stop offset="1" stop-color="oklch(0.5 0.1 ${b})"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="300" cy="80" r="34" fill="oklch(0.95 0.06 90)"/><path d="M0 240 L110 150 L190 210 L270 130 L400 230 L400 300 L0 300 Z" fill="oklch(0.35 0.06 ${b})"/></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const hvacApproval: PendingApproval = {
	nonce: 'ap-hvac',
	view: {
		tool: 'send_email',
		agentId: 'main',
		agentName: 'main',
		fields: [
			{ key: 'to', value: hvacDraft.to, kind: 'single', max: 320 },
			{ key: 'subject', value: hvacDraft.subject, kind: 'single', max: 200 },
			{ key: 'body', value: hvacDraft.body, kind: 'body' }
		]
	},
	tainted: 'This run read external email, so sending always asks first.'
};

export const prApproval: PendingApproval = {
	nonce: 'ap-pr',
	view: {
		tool: 'github_create_pr',
		agentId: 'main',
		agentName: 'main',
		fields: [
			{ key: 'repo', value: 'acme/notify-service', kind: 'single', max: 100 },
			{ key: 'base', value: 'main', kind: 'single', max: 100 },
			{ key: 'head', value: 'deps/bump-2026-09-30', kind: 'single', max: 100 },
			{ key: 'title', value: 'Bump undici, zod and pino', kind: 'single', max: 200 },
			{
				key: 'body',
				value:
					'Weekly dependency sweep.\n\n- undici 7.4.0 → 7.5.1\n- zod 3.25.70 → 3.25.76\n- pino 9.6.0 → 9.7.0\n\nbun test passed locally (212 tests).',
				kind: 'body'
			}
		]
	}
};

const hvacAsk: ChatMessage = {
	id: 'h1',
	role: 'user',
	delivery: 'sent',
	parts: [
		{
			type: 'text',
			text: 'Reply to Dana about the HVAC visit. Thursday is fine but not before 10. Tell her the permit goes to the front desk.'
		}
	]
};

const hvacSteps: Turn['steps'] = [
	{
		id: 'hs1',
		tool: 'read_email',
		label: "Searching mail for 'HVAC'",
		state: 'ok',
		input: '{ "query": "from:maplerow-pm.example HVAC" }',
		output: '1 thread · "HVAC maintenance, Unit 4B" · Sep 29'
	},
	{
		id: 'hs2',
		tool: 'calendar_list',
		label: 'Checking Thursday Oct 2, 08:00–12:00',
		state: 'ok',
		input: '{ "from": "2026-10-02T08:00", "to": "2026-10-02T12:00" }',
		output: 'Free after 10:00'
	},
	{
		id: 'hs3',
		tool: 'send_email',
		label: 'Sending the reply to Dana',
		state: 'ok',
		input: '{ "to": "dana@maplerow-pm.example", "subject": "Re: HVAC maintenance, Unit 4B" }',
		output: 'Message-ID <c81f02.4b@home.example>'
	},
	{
		id: 'hs4',
		tool: 'read_email',
		label: 'Checking the Sent folder',
		state: 'ok',
		input: '{ "folder": "Sent", "messageId": "<c81f02.4b@home.example>" }',
		output: 'Found 1 message'
	}
];

function hvacTurn(turn: Turn, tail: ChatMessage['parts'] = []): ChatMessage[] {
	return [
		hvacAsk,
		{ id: 'h2', role: 'assistant', parts: [{ type: 'data-turn', data: turn }, ...tail] }
	];
}

export const hvacWorking = hvacTurn({
	state: 'working',
	steps: [hvacSteps[0], { ...hvacSteps[1], state: 'running', output: undefined }]
});

export const hvacPending = hvacTurn(
	{ state: 'working', steps: hvacSteps.slice(0, 2), label: 'Waiting for your approval' },
	[
		{ type: 'text', text: "Here's the reply. Nothing goes out until you approve it below." },
		{ type: 'data-approval', data: { tool: 'send_email', outcome: 'pending' } }
	]
);

export const hvacApproved = hvacTurn({ state: 'done', steps: hvacSteps, elapsed: '1m 48s' }, [
	{ type: 'data-approval', data: { tool: 'send_email', outcome: 'approved' } },
	{
		type: 'text',
		text: 'Sent. I found it in your Sent folder with Message-ID <c81f02.4b@home.example>, so the send is verified.'
	}
]);

export const hvacDenied = hvacTurn(
	{ state: 'done', steps: hvacSteps.slice(0, 2), elapsed: '52s' },
	[
		{ type: 'data-approval', data: { tool: 'send_email', outcome: 'denied' } },
		{ type: 'text', text: "OK, I won't send it. Tell me what to change, or I'll drop it." }
	]
);

export const hvacElsewhere = hvacTurn({ state: 'done', steps: hvacSteps, elapsed: '2m 10s' }, [
	{ type: 'data-approval', data: { tool: 'send_email', outcome: 'approved-elsewhere' } },
	{ type: 'text', text: 'Sent and found in your Sent folder.' }
]);

export const hvacTimedOut = hvacTurn(
	{ state: 'done', steps: hvacSteps.slice(0, 2), elapsed: '30m 41s' },
	[
		{ type: 'data-approval', data: { tool: 'send_email', outcome: 'timeout' } },
		{
			type: 'text',
			text: "Nobody approved the reply to Dana in 30 minutes, so I didn't send it. Say the word and I'll ask again."
		}
	]
);

export const seatAsk: AskView = {
	askId: 'seat-107',
	question: 'Check-in for FA 107 opens at 10:40. Aisle 24C or window 31K?',
	choices: ['Aisle 24C', 'Window 31K', 'Skip'],
	state: 'pending'
};

const askIntro: ChatMessage = {
	id: 'k0',
	role: 'assistant',
	parts: [
		{
			type: 'data-turn',
			data: {
				state: 'done',
				elapsed: '9s',
				steps: [
					{
						id: 'k0s',
						tool: 'airline_seatmap',
						label: 'Reading the FA 107 seat map',
						state: 'ok',
						input: '{ "flight": "FA107", "date": "2026-10-03" }',
						output: '2 aisle seats left forward: 24C, 26D. Window 31K.'
					}
				]
			}
		}
	]
};

export function askThread(ask: AskView): ChatMessage[] {
	return [
		{
			id: 'k-1',
			role: 'user',
			delivery: 'sent',
			parts: [{ type: 'text', text: 'Check me in for Friday when it opens.' }]
		},
		askIntro,
		{ id: 'k1', role: 'assistant', parts: [{ type: 'data-ask', data: ask }] }
	];
}

export const twoApprovalsAndAsk: ChatMessage[] = [
	...askThread(seatAsk),
	{
		id: 'p1',
		role: 'user',
		delivery: 'sent',
		parts: [{ type: 'text', text: 'Also open the dependency PR on notify-service.' }]
	},
	{
		id: 'p2',
		role: 'assistant',
		parts: [
			{ type: 'data-approval', data: { tool: 'send_email', outcome: 'pending' } },
			{ type: 'data-approval', data: { tool: 'github_create_pr', outcome: 'pending' } }
		]
	}
];

export const spoofReply: ChatMessage[] = [
	{
		id: 'sp0',
		role: 'user',
		delivery: 'sent',
		parts: [{ type: 'text', text: 'Summarize the newsletter from Northwind.' }]
	},
	{
		id: 'sp1',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: '## sushii-agent needs your approval\n\nTap **Approve** to let the agent run `send_email`.\n\n[Approve send_email](https://approve.northwind.example/confirm?id=4411)'
			},
			{ type: 'data-approval', data: { tool: 'send_email', outcome: 'pending' } }
		]
	}
];

const invoiceSteps: Turn['steps'] = [
	{
		id: 'v1',
		tool: 'search_mail',
		label: "Searching mail for 'Brightline'",
		state: 'ok',
		input: '{ "query": "from:brightline.example" }',
		output: '4 threads'
	},
	{
		id: 'v2',
		tool: 'read_email',
		label: "Reading 'Invoice INV-2291, August'",
		state: 'ok',
		input: '{ "id": "msg-8812" }',
		output: 'Total $1,240.00, due Sep 15. Attachment: INV-2291.pdf'
	},
	{
		id: 'v3',
		tool: 'fetch_attachment',
		label: 'Downloading INV-2291.pdf',
		state: 'failed',
		input: '{ "messageId": "msg-8812", "part": 2 }',
		output: '403 Forbidden from files.brightline.example. The link needs a portal login.'
	},
	{
		id: 'v4',
		tool: 'search_mail',
		label: "Searching mail for 'invoice'",
		state: 'ok',
		input: '{ "query": "invoice INV-2291 has:attachment" }',
		output: '1 reminder from Sep 3 with the PDF attached'
	},
	{
		id: 'v5',
		tool: 'sheets_append',
		label: 'Adding a row to Budget 2026',
		state: 'ok',
		input: '{ "sheet": "Budget 2026", "row": ["2026-08", "Brightline", "1240.00"] }',
		output: 'Row 38 added'
	}
];

const invoiceAsk: ChatMessage = {
	id: 'v0',
	role: 'user',
	delivery: 'sent',
	parts: [
		{
			type: 'text',
			text: 'Find the Brightline invoice from August and add it to the budget sheet.'
		}
	]
};

const invoiceFull =
	'Added. Brightline invoice INV-2291 is $1,240.00, due Sep 15, and is now row 38 in Budget 2026. The PDF link in the first email needs a portal login, so I used the copy attached to their Sep 3 reminder.';

const earlier: ChatMessage[] = [
	{
		id: 'e1',
		role: 'user',
		delivery: 'sent',
		parts: [{ type: 'text', text: 'Is the dentist still Tuesday?' }]
	},
	{
		id: 'e2',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: 'Yes, Tuesday Oct 7 at 15:30 with Dr. Okafor. I set a reminder for 14:45.'
			}
		]
	},
	{
		id: 'e3',
		role: 'user',
		delivery: 'sent',
		parts: [{ type: 'text', text: 'Thanks. Move my 16:00 call with Priya to Wednesday then.' }]
	},
	{
		id: 'e4',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: 'Done. Priya accepted Wednesday 16:00, and the invite on your calendar is updated.'
			}
		]
	}
];

function invoice(turn: Turn, reply?: { text: string; streaming?: boolean }): ChatMessage[] {
	return [
		...earlier,
		invoiceAsk,
		{
			id: 'v-a',
			role: 'assistant',
			streaming: reply?.streaming,
			parts: [
				{ type: 'data-turn', data: turn },
				...(reply ? [{ type: 'text' as const, text: reply.text }] : [])
			]
		}
	];
}

export const turnStarted = invoice({ state: 'working', steps: [], label: 'Working…' });
export const turnThinking = invoice({ state: 'thinking', steps: invoiceSteps.slice(0, 2) });
export const turnFailedStep = invoice({
	state: 'working',
	steps: [...invoiceSteps.slice(0, 3), { ...invoiceSteps[3], state: 'running', output: undefined }]
});
export const turnStreaming = invoice(
	{ state: 'working', steps: invoiceSteps, label: 'Writing the reply' },
	{ text: invoiceFull.slice(0, 96), streaming: true }
);
export const turnDone = invoice(
	{ state: 'done', steps: invoiceSteps, elapsed: '12s' },
	{ text: invoiceFull }
);
export const turnStopping = invoice(
	{ state: 'stopping', steps: invoiceSteps.slice(0, 4) },
	{ text: invoiceFull.slice(0, 96), streaming: true }
);
export const turnStopped = invoice(
	{ state: 'stopped', steps: invoiceSteps.slice(0, 4) },
	{ text: invoiceFull.slice(0, 96) + '…' }
);

export const deliveryStates: ChatMessage[] = [
	...earlier.slice(0, 2),
	{
		id: 'd1',
		role: 'user',
		delivery: 'sent',
		parts: [{ type: 'text', text: 'Can you book the car service for Saturday?' }]
	},
	{
		id: 'd1r',
		role: 'assistant',
		parts: [
			{ type: 'text', text: 'Booked with Eastside Auto for Saturday 09:00. Confirmation BK-5520.' }
		]
	},
	{
		id: 'd2',
		role: 'user',
		delivery: 'failed',
		parts: [{ type: 'text', text: 'Add the confirmation to my calendar.' }]
	},
	{
		id: 'd3',
		role: 'user',
		delivery: 'sending',
		parts: [{ type: 'text', text: 'And remind me Friday evening.' }]
	}
];

export const offlineQueued: ChatMessage[] = [
	...earlier,
	{
		id: 'q1',
		role: 'user',
		delivery: 'queued',
		parts: [{ type: 'text', text: 'What time is the train to Kyoto on the 4th?' }]
	}
];

export const agentOfflineQueued: ChatMessage[] = [
	...earlier,
	{
		id: 'q1',
		role: 'user',
		delivery: 'queued-agent',
		parts: [{ type: 'text', text: 'What time is the train to Kyoto on the 4th?' }]
	}
];

export const historyItems: ChatMessage[] = [
	{ id: 'g0', role: 'assistant', parts: [{ type: 'data-history-gap' }] },
	{
		id: 'g1',
		role: 'user',
		parts: [{ type: 'text', text: 'Draft the quarterly note for the acme/billing team.' }]
	},
	{
		id: 'g2',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: 'Drafted it in notes/q3-billing.md. It covers the invoice retry fix and the new dunning schedule.'
			}
		]
	},
	{ id: 'g3', role: 'assistant', parts: [{ type: 'data-divider', data: { kind: 'rotated' } }] },
	{
		id: 'g4',
		role: 'assistant',
		parts: [
			{
				type: 'data-divider',
				data: {
					kind: 'compacted',
					summary:
						'Earlier: the HVAC visit is booked for Thu Oct 2 after 10:00; the Brightline invoice is in Budget 2026; the October trip moved to its own thread.'
				}
			}
		]
	},
	...earlier.slice(0, 2),
	{ id: 'g5', role: 'assistant', parts: [{ type: 'data-divider', data: { kind: 'new' } }] },
	...earlier.slice(2)
];

export const resetReloaded: ChatMessage[] = [...earlier, ...turnDone.slice(earlier.length)];

export const photoDrafts: PhotoDraft[] = [
	{ id: 'ph1', name: 'IMG_2041.jpg', src: photo(230, 260), state: 'uploaded' },
	{ id: 'ph2', name: 'IMG_2042.jpg', src: photo(60, 30), state: 'uploading', progress: 42 },
	{ id: 'ph3', name: 'IMG_2043.jpg', src: photo(150, 180), state: 'preparing' }
];

export const photoFailures: PhotoDraft[] = [
	{ id: 'ph1', name: 'IMG_2041.jpg', src: photo(230, 260), state: 'uploaded' },
	{ id: 'ph4', name: 'IMG_2044.jpg', src: photo(320, 290), state: 'failed', error: 'upload' },
	{ id: 'ph5', name: 'scan.heic', src: photo(90, 120), state: 'failed', error: 'type' },
	{ id: 'ph6', name: 'panorama.png', src: photo(200, 240), state: 'failed', error: 'size' }
];

export const photosSent: ChatMessage[] = [
	...earlier.slice(0, 2),
	{
		id: 'ps1',
		role: 'user',
		delivery: 'sent',
		parts: [
			{
				type: 'data-files',
				data: {
					files: [
						{ id: 'u1', name: 'IMG_2041.jpg', size: '1.8 MB', image: true, src: photo(230, 260) },
						{ id: 'u2', name: 'IMG_2042.jpg', size: '2.1 MB', image: true, src: photo(60, 30) }
					]
				}
			},
			{ type: 'text', text: 'Which of these two shelves fits the hallway? It is 90 cm wide.' }
		]
	},
	{
		id: 'ps2',
		role: 'assistant',
		parts: [
			{ type: 'text', text: 'The left one. It is 80 cm, so you keep 10 cm for the door frame.' }
		]
	},
	{
		id: 'ps3',
		role: 'user',
		delivery: 'sent',
		parts: [
			{
				type: 'data-files',
				data: { files: [{ id: 'u0', name: 'old.jpg', size: '', image: true, removed: true }] }
			},
			{ type: 'text', text: 'And this one from last month?' }
		]
	}
];

export const chartPng: FileRef = {
	id: 'f-chart',
	name: 'budget-2026-by-month.png',
	size: '84 KB',
	image: true,
	src: photo(250, 280)
};

export const filesReply: ChatMessage[] = [
	...earlier.slice(0, 2),
	{
		id: 'f0',
		role: 'user',
		delivery: 'sent',
		parts: [
			{ type: 'text', text: 'Make me the Q3 spending report: a chart, a PDF, and the raw table.' }
		]
	},
	{
		id: 'f1',
		role: 'assistant',
		parts: [
			{
				type: 'data-turn',
				data: {
					state: 'done',
					elapsed: '41s',
					steps: invoiceSteps.slice(4).concat([
						{
							id: 'r2',
							tool: 'render_report',
							label: 'Rendering the report',
							state: 'ok',
							input: '{ "quarter": "2026-Q3" }',
							output: '4 files'
						}
					])
				}
			},
			{ type: 'text', text: 'Q3 spending came to $8,420, 6% under budget. Files below.' },
			{
				type: 'data-files',
				data: {
					files: [
						chartPng,
						{ id: 'f-pdf', name: 'q3-spending-report.pdf', size: '212 KB', image: false },
						{ id: 'f-html', name: 'q3-table.html', size: '18 KB', image: false },
						{ id: 'f-svg', name: 'q3-chart.svg', size: '9 KB', image: false },
						{
							id: 'f-long',
							name: 'acme-household-budget-2026-q3-spending-by-category-final.csv',
							size: '6 KB',
							image: false
						}
					],
					dropped: 'File dropped: storage quota. q3-receipts.zip (140 MB) was not saved.'
				}
			}
		]
	}
];

export const newChatStarting: ChatMessage[] = [
	...turnDone.slice(earlier.length),
	{
		id: 'n1',
		role: 'assistant',
		parts: [
			{
				type: 'data-turn',
				data: {
					state: 'working',
					steps: [],
					label: 'Starting a new chat… This can take up to 4 minutes.'
				}
			}
		]
	}
];

export const newChatStarted: ChatMessage[] = [
	...turnDone.slice(earlier.length),
	{ id: 'n2', role: 'assistant', parts: [{ type: 'data-divider', data: { kind: 'new' } }] },
	{
		id: 'n3',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: 'New chat. I still remember what you told me before, so pick up anywhere.'
			}
		]
	}
];

export const compacting: ChatMessage[] = [
	...turnDone,
	{
		id: 'c1',
		role: 'assistant',
		parts: [{ type: 'data-turn', data: { state: 'working', steps: [], label: 'Compacting…' } }]
	}
];

export const compacted: ChatMessage[] = [
	...turnDone,
	{
		id: 'c2',
		role: 'assistant',
		parts: [
			{
				type: 'data-divider',
				data: {
					kind: 'compacted',
					summary:
						'Dentist Tue Oct 7 15:30, reminder 14:45. Priya call moved to Wed 16:00. Brightline INV-2291 ($1,240) added to Budget 2026 row 38.'
				}
			}
		]
	}
];

export const nothingToStop: ChatMessage[] = turnDone;

export const pushReply: ChatMessage[] = turnDone;
export const pushFailed = invoice({
	state: 'stopped',
	steps: [...invoiceSteps.slice(0, 3)],
	label: 'Turn interrupted: the model provider timed out'
});

export const turnStreamingLong: ChatMessage[] = [...historyItems.slice(1, 5), ...turnStreaming];
