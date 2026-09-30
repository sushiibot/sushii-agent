import type {
	MemoryWrite,
	Session,
	ThreadClose,
	BriefItem,
	ChatMessage,
	DaySummary,
	EmailDraft,
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
		tainted: true
	},
	{
		id: 'in-flight',
		state: 'waiting',
		title: 'Pick a seat for FA 107 to Haneda',
		source: 'Thread · October trip',
		when: '38 min ago',
		summary: 'Check-in opens at 10:40. Two aisle seats left in the forward cabin.',
		question: 'Aisle 24C or window 31K? Reply with a seat or "skip".',
		runId: 'run-checkin'
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

export const replySent: InboxItem[] = inbox.map((item) =>
	item.id === 'in-flight'
		? {
				...item,
				state: 'running',
				when: 'just now',
				summary: 'Checking in with seat 24C and saving the boarding pass.'
			}
		: item
);

export const hvacDraft: EmailDraft = {
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

export const hvacEdited: EmailDraft = {
	...hvacDraft,
	body: `Hi Dana,

Thursday works. Any time after 10am is fine. I'll be home, so just knock.

Please send the permit to the front desk. Is there anything I should move away from the unit before the visit?

Thanks,
Sam`,
	changes: [
		{ kind: 'ctx', text: 'Hi Dana,' },
		{ kind: 'ctx', text: '' },
		{
			kind: 'del',
			text: "Thursday works. Any time after 10am is fine, and I'll leave the side gate unlocked."
		},
		{
			kind: 'add',
			text: "Thursday works. Any time after 10am is fine. I'll be home, so just knock."
		},
		{ kind: 'ctx', text: '' },
		{ kind: 'ctx', text: 'Please send the permit to the front desk. Is there anything I…' }
	]
};

export const chatMessages: ChatMessage[] = [
	{
		id: 'm1',
		role: 'user',
		parts: [
			{
				type: 'text',
				text: 'Reply to Dana about the HVAC visit. Thursday is fine but not before 10. Tell her the permit goes to the front desk.'
			}
		]
	},
	{
		id: 'm2',
		role: 'assistant',
		parts: [
			{
				type: 'tool-read_email',
				toolCallId: 'tc1',
				state: 'output-available',
				input: { query: 'from:maplerow-pm.example HVAC' },
				output: { found: '1 thread · "HVAC maintenance, Unit 4B" · Sep 29' }
			},
			{
				type: 'text',
				text: "Found Dana's email from this morning. She offered Thursday Oct 2, 8am to 12pm, and asked where the van permit should go."
			}
		]
	}
];

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
		preview: 'October trip closed: flight booked, hotel still open.',
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
