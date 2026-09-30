import type { ChatUsage } from '$lib/core/realtime/events';
import type { AskView, ChatMessage, FileRef, PendingApproval, PhotoDraft, Turn } from './types';

// Every person, company, address and id below is invented. Photos are inline SVG so the board and
// the harness need no network.

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
		unverified: true,
		parts: [{ type: 'text', text: 'Draft the quarterly note for the acme/billing team.' }]
	},
	{
		id: 'g2',
		role: 'assistant',
		unverified: true,
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

export const lastUsage: ChatUsage = {
	model: 'openrouter/deepseek/deepseek-v4.1-flash',
	inputTokens: 18_204,
	outputTokens: 412,
	cacheRead: 16_000,
	cacheWrite: 1_024,
	costUsd: 0.0123,
	contextPct: 34
};
