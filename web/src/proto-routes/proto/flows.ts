import type { Component } from 'svelte';
import type { FeatureCheck } from '$lib/core/nav/nav';
import { ChatScreen } from '$lib/features/chat';
import { SettingsScreen } from '$lib/features/settings';
import HomeScreen from './components/home-screen.svelte';
import DiscordDm from './components/discord-dm.svelte';
import * as c from '$lib/features/chat/fixtures';
import { m23Flows, m23Routes } from './m23-flows';
import { m4Flows, m4Routes } from './m4-flows';
import { m5Flows, m5Routes } from './m5-flows';
import { m67Flows, m67Routes } from './m67-flows';

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
	/** An Android heads-up notification over the screen; tapping it follows `hits`. */
	notification?: { title: string; body: string; when?: string };
	/** Fixed phone width, whatever the board toggle says. */
	width?: number;
	/** Start the chat scrolled this many px up from the newest message. */
	scrollUp?: number;
	/** Render inside the app's Shell, as routes do; the legacy prototype screens bring their own. */
	shell?: boolean;
	/** The Shell's lit nav entry, tab bar and badges, as the route's layout sets them. */
	tab?: string;
	tabBar?: boolean;
	badges?: Record<string, number>;
	/** Which slices the Shell's nav shows; every one by default. */
	features?: FeatureCheck;
	/** Start a top-anchored screen scrolled down this many px. */
	scrollTo?: number;
}

export interface Flow {
	id: string;
	code: string;
	title: string;
	intro: string;
	/** Deviation ids from `deviations` that this flow shows. */
	deviations?: number[];
	frames: Frame[];
}

export const deviations = [
	{
		id: 1,
		title: 'Approvals attach to the tool call',
		detail:
			'Each request renders beside its tool activity. Confirmed decisions remove the controls and remain in the tool details.',
		flow: 'chat'
	},
	{
		id: 2,
		title: 'No Edit action',
		detail:
			'UXG lists Approve, Edit, Deny. Bot approvals take no edited input, so M1 shows Deny and Approve, with the tool name on the line above them.',
		flow: 'chat'
	},
	{
		id: 3,
		title: 'The bot times out after 30 min, as a deny',
		detail:
			'The UI expires no request on its own. When the bot reports a timeout, controls disappear and the tool details retain the expired decision.',
		flow: 'chat'
	},
	{
		id: 4,
		title: 'Submitting prevents duplicate decisions',
		detail:
			'Deny sits on the left and is the smaller target. Both controls disable while the server confirms; failed decisions can be retried.',
		flow: 'chat'
	}
];

const settings = (push: string, props: Record<string, unknown> = {}) => ({
	back: { href: '/more', label: 'Back' },
	me: { status: 'ready', data: { login: 'owner@example.com' } },
	push,
	theme: 'system',
	version: '2026.09.30',
	standalone: true,
	...props
});

export const flows: Flow[] = [
	{
		id: 'install',
		code: 'IN',
		title: 'Install and first launch',
		intro:
			'Chrome offers to install; the app shows a quiet hint until you do or dismiss it. The installed app opens full screen. Notifications are asked for only after you turn them on in Settings, which says what will ring. iOS install is out of scope for now.',
		frames: [
			{
				id: 'in-1',
				label: 'In a Chrome tab: the install hint',
				screen: ChatScreen,
				props: { messages: [], canInstall: true },
				shell: true,
				next: 'Install'
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
				label: 'Settings: notifications not asked yet',
				screen: SettingsScreen,
				props: settings('off'),
				shell: true,
				tab: 'more',
				next: 'Turn on',
				hits: { 'notify this device': 'in-4' }
			},
			{
				id: 'in-4',
				label: 'System ask, after the tap',
				screen: SettingsScreen,
				props: settings('off', { pushBusy: true }),
				shell: true,
				tab: 'more',
				alert: 'push',
				next: 'Allow'
			},
			{
				id: 'in-5',
				label: 'Notifications on',
				screen: SettingsScreen,
				props: settings('on'),
				shell: true,
				tab: 'more'
			},
			{
				id: 'in-6',
				label: 'Blocked, with steps to undo it',
				screen: SettingsScreen,
				props: settings('blocked'),
				shell: true,
				tab: 'more',
				branch: 'Don’t allow, or blocked earlier'
			},
			{
				id: 'in-7',
				label: 'Unsupported browser',
				screen: SettingsScreen,
				props: settings('unsupported'),
				shell: true,
				tab: 'more',
				branch: 'No Push API in this browser'
			}
		]
	},
	...m23Flows,
	...m4Flows,
	{
		id: 'chat',
		code: 'CH',
		title: 'Chat turn with approval',
		intro:
			'The agent drafts an email and asks to send it. A compact inline approval shows structured details and exact input. Confirmed decisions leave a quiet record, while tool execution has its own status.',
		deviations: [1, 2, 3, 4],
		frames: [
			{
				id: 'ch-1',
				label: 'Working: Send steers, Stop sits apart',
				screen: ChatScreen,
				props: { messages: c.hvacWorking, running: true },
				next: 'Asks to send'
			},
			{
				id: 'ch-2',
				label: 'Inline approval appears',
				screen: ChatScreen,
				props: {
					messages: c.hvacPending,
					running: true,
					approvals: [c.hvacApproval]
				},
				next: 'Review details'
			},
			{
				id: 'ch-3',
				label: 'Ready to decide',
				screen: ChatScreen,
				props: {
					messages: c.hvacPending,
					running: true,
					approvals: [c.hvacApproval]
				},
				next: 'Approve',
				hits: { approve: 'ch-4', deny: 'ch-6', 'show details': 'ch-11' }
			},
			{
				id: 'ch-4',
				label: 'Submitting',
				screen: ChatScreen,
				props: {
					messages: c.hvacPending,
					running: true,
					approvals: [c.hvacApproval],
					approvalSubmitting: true
				},
				next: 'Bot confirms'
			},
			{
				id: 'ch-5',
				label: 'Approved, sent with evidence',
				screen: ChatScreen,
				props: { messages: c.hvacApproved, openTurn: 'h2' }
			},
			{
				id: 'ch-6',
				label: 'Denied',
				screen: ChatScreen,
				props: { messages: c.hvacDenied },
				branch: 'Deny from CH-3'
			},
			{
				id: 'ch-7',
				label: 'Two inline approvals, and a question',
				screen: ChatScreen,
				props: {
					messages: c.twoApprovalsAndAsk,
					running: true,
					approvals: [c.hvacApproval, c.prApproval]
				},
				branch: 'Each pending call has its own inline decision; the question stays in the chat'
			},
			{
				id: 'ch-8',
				label: 'Decided on another device',
				screen: ChatScreen,
				props: { messages: c.hvacElsewhere },
				branch: 'Approved on the laptop: controls close and tool details retain the decision'
			},
			{
				id: 'ch-9',
				label: 'Timed out, denied',
				screen: ChatScreen,
				props: {
					messages: c.hvacTimedOut,
					approvals: []
				},
				branch:
					'Nobody decided in 30 min: the bot denies and tool details retain the expired decision',
				next: 'After about 3s'
			},
			{
				id: 'ch-12',
				label: 'Folded into the chat marker',
				screen: ChatScreen,
				props: {
					messages: c.hvacTimedOut,
					approvals: []
				},
				branch: 'The tool details keep the outcome'
			},
			{
				id: 'ch-10',
				label: 'A reply that imitates an approval',
				screen: ChatScreen,
				props: {
					messages: c.spoofReply,
					running: true,
					approvals: [c.hvacApproval]
				},
				branch:
					'Spoof: markdown with a heading, bold “Approve” and a link; no buttons, next to the real inline approval'
			},
			{
				id: 'ch-11',
				label: 'Show details: the exact input',
				screen: ChatScreen,
				props: {
					messages: c.hvacPending,
					running: true,
					approvals: [c.hvacApproval]
				},
				hits: { approve: 'ch-4', deny: 'ch-6', 'hide details': 'ch-3' },
				branch: 'Show details from CH-3: every field, scrolling inside the inline approval'
			}
		]
	},
	{
		id: 'asks',
		code: 'AS',
		title: 'The agent asks',
		intro:
			'A question is the agent talking, so it renders in the chat in the agent’s voice: plain chips and a free-text answer, no shield, no approval color. It says it is not a permission.',
		frames: [
			{
				id: 'as-1',
				label: 'Question, opened from Home or a push',
				screen: ChatScreen,
				props: { messages: c.askThread(c.seatAsk), focusAsk: 'seat-107' },
				next: 'Tap Aisle 24C',
				hits: { 'aisle 24c': 'as-2' }
			},
			{
				id: 'as-2',
				label: 'Sending the answer',
				screen: ChatScreen,
				props: {
					messages: c.askThread({ ...c.seatAsk, state: 'answering', answer: 'Aisle 24C' })
				},
				next: 'Delivered'
			},
			{
				id: 'as-3',
				label: 'Answered',
				screen: ChatScreen,
				props: {
					messages: c.askThread({ ...c.seatAsk, state: 'answered', answer: 'Aisle 24C' }),
					running: true
				}
			},
			{
				id: 'as-4',
				label: 'Answered on another device',
				screen: ChatScreen,
				props: {
					messages: c.askThread({ ...c.seatAsk, state: 'elsewhere', answer: 'Window 31K' })
				},
				branch: 'Answered on the laptop first'
			},
			{
				id: 'as-5',
				label: 'In history: inert',
				screen: ChatScreen,
				props: {
					messages: c.askThread({ ...c.seatAsk, state: 'history', answer: 'Aisle 24C' })
				},
				branch: 'Reloaded from the transcript: no chips'
			}
		]
	},
	{
		id: 'turn',
		code: 'TU',
		title: 'Working, streaming, stop',
		intro:
			'Each turn gets one “Working” row: the current step in plain words and a count. A failed step shows while collapsed. The reply streams into a bubble that already has its height, and the row folds to a summary when the turn ends.',
		frames: [
			{
				id: 'tu-1',
				label: 'Within 300 ms of Send',
				screen: ChatScreen,
				props: { messages: c.turnStarted, running: true },
				next: 'No token for 2s'
			},
			{
				id: 'tu-2',
				label: 'Thinking, never a bare spinner',
				screen: ChatScreen,
				props: { messages: c.turnThinking, running: true },
				next: 'Tools run'
			},
			{
				id: 'tu-3',
				label: 'Current step, count, one failed',
				screen: ChatScreen,
				props: { messages: c.turnFailedStep, running: true },
				next: 'Tap the row'
			},
			{
				id: 'tu-4',
				label: 'Expanded: steps, then exact input and output',
				screen: ChatScreen,
				props: {
					messages: c.turnFailedStep,
					running: true,
					openTurn: 'v-a',
					openStep: 'v3'
				},
				next: 'First delta'
			},
			{
				id: 'tu-5',
				label: 'Streaming into a reserved bubble',
				screen: ChatScreen,
				props: { messages: c.turnStreaming, running: true },
				next: 'Turn ends'
			},
			{
				id: 'tu-6',
				label: 'Final reply; screen reader hears “Agent replied” once',
				screen: ChatScreen,
				props: { messages: c.turnDone, announce: 'Agent replied', usage: c.lastUsage },
				hits: { deepseek: 'tu-12' }
			},
			{
				id: 'tu-12',
				label: 'Last reply usage',
				screen: ChatScreen,
				props: { messages: c.turnDone, usage: c.lastUsage, sheet: 'usage' },
				hits: { close: 'tu-6' },
				branch: 'Tap the line under the composer'
			},
			{
				id: 'tu-7',
				label: 'Scrolled up: New messages pill',
				screen: ChatScreen,
				props: {
					messages: c.turnStreamingLong,
					running: true,
					newMessages: true
				},
				scrollUp: 260,
				branch: 'Reading older messages while it streams; nothing moves'
			},
			{
				id: 'tu-8',
				label: 'Stopping…',
				screen: ChatScreen,
				props: { messages: c.turnStopping, running: true, stopping: true },
				branch: 'Tap Stop mid-stream',
				next: 'Stopped'
			},
			{
				id: 'tu-9',
				label: 'Stopped by you, partial text kept',
				screen: ChatScreen,
				props: { messages: c.turnStopped },
				branch: 'The turn ends where it was'
			},
			{
				id: 'tu-10',
				label: 'Nothing to stop',
				screen: ChatScreen,
				props: {
					messages: c.nothingToStop,
					connection: { kind: 'agent-offline' },
					toast: 'Nothing to stop. The agent is offline.'
				},
				branch: 'Stop from the command menu while the agent is offline'
			},
			{
				id: 'tu-11',
				label: 'Typing mid-run: Send steers it',
				screen: ChatScreen,
				props: {
					messages: c.turnFailedStep,
					running: true,
					draft: 'Only the 2024 invoices, skip the rest'
				},
				keyboard: ['rest', 'rest of', 'others'],
				branch: 'Send stays on while it works; the message steers this run'
			}
		]
	},
	{
		id: 'delivery',
		code: 'DL',
		title: 'Delivery and connection',
		intro:
			'Every message says whether it went. Connection problems get a banner with the next step; nothing asks you to reload, and nothing duplicates when it comes back.',
		frames: [
			{
				id: 'dl-1',
				label: 'Sent, failed with Retry, sending',
				screen: ChatScreen,
				props: { messages: c.deliveryStates }
			},
			{
				id: 'dl-2',
				label: 'Offline: queued',
				screen: ChatScreen,
				props: {
					messages: c.offlineQueued,
					connection: { kind: 'offline' }
				},
				branch: 'The phone lost its connection'
			},
			{
				id: 'dl-3',
				label: 'Reconnecting, with elapsed time',
				screen: ChatScreen,
				props: {
					messages: c.turnStreaming,
					running: true,
					connection: { kind: 'reconnecting', elapsed: '12s' }
				},
				branch: 'Back on the network: it resumes by itself'
			},
			{
				id: 'dl-4',
				label: 'The agent is offline',
				screen: ChatScreen,
				props: {
					messages: c.agentOfflineQueued,
					connection: { kind: 'agent-offline' }
				},
				branch: 'The phone is online, the workspace is not; no fallback agent answers'
			},
			{
				id: 'dl-5',
				label: 'Reloaded after a long absence',
				screen: ChatScreen,
				props: { messages: c.resetReloaded, connection: { kind: 'reset' } },
				branch: 'Away longer than the live buffer'
			},
			{
				id: 'dl-6',
				label: 'History: dividers, unverified, unavailable',
				screen: ChatScreen,
				props: { messages: c.historyItems },
				scrollUp: 2000,
				branch: 'Scrolled to the top of what loaded'
			}
		]
	},
	{
		id: 'photos',
		code: 'PH',
		title: 'Send photos',
		intro:
			'Attach opens the Android picker. Photos wait in a tray above the composer with their own state, and Send stays off with a reason until every photo is up.',
		frames: [
			{
				id: 'ph-1',
				label: 'Preparing and uploading',
				screen: ChatScreen,
				props: {
					messages: c.turnDone,
					photos: c.photoDrafts,
					draft: 'Which of these fits the hallway?'
				},
				next: 'Some fail'
			},
			{
				id: 'ph-2',
				label: 'Failed, unsupported, too large',
				screen: ChatScreen,
				props: { messages: c.turnDone, photos: c.photoFailures },
				next: 'Retry and send'
			},
			{
				id: 'ph-3',
				label: 'Sent inline; a deleted photo says so',
				screen: ChatScreen,
				props: { messages: c.photosSent }
			},
			{
				id: 'ph-4',
				label: 'Photo storage full',
				screen: ChatScreen,
				props: { messages: c.turnDone, quotaFull: true },
				branch: 'The server answers 507'
			}
		]
	},
	{
		id: 'commands',
		code: 'CM',
		title: 'Commands: new, stop, compact',
		intro:
			'The chat’s commands live behind the top-bar button, in a sheet that Back closes. Starting a new chat confirms first, and every command shows a working row until it lands.',
		frames: [
			{
				id: 'cm-1',
				label: 'Command sheet',
				screen: ChatScreen,
				props: { messages: c.turnDone, sheet: 'commands' },
				next: 'New chat',
				hits: { 'new chat': 'cm-2', compact: 'cm-5' }
			},
			{
				id: 'cm-2',
				label: 'Confirm a new chat',
				screen: ChatScreen,
				props: { messages: c.turnDone, sheet: 'new' },
				next: 'Start new chat',
				hits: { 'start new chat': 'cm-3', cancel: 'cm-1' }
			},
			{
				id: 'cm-3',
				label: 'Starting a new chat',
				screen: ChatScreen,
				props: { messages: c.newChatStarting, running: true },
				next: 'Ready'
			},
			{
				id: 'cm-4',
				label: 'New chat divider',
				screen: ChatScreen,
				props: { messages: c.newChatStarted }
			},
			{
				id: 'cm-5',
				label: 'Compacting',
				screen: ChatScreen,
				props: { messages: c.compacting, running: true },
				branch: 'Compact from the sheet',
				next: 'Done'
			},
			{
				id: 'cm-6',
				label: 'Compacted, summary expanded',
				screen: ChatScreen,
				props: { messages: c.compacted, openTurn: 'c2' },
				branch: 'The divider opens to the summary'
			},
			{
				id: 'cm-7',
				label: 'Commands while the agent is offline',
				screen: ChatScreen,
				props: {
					messages: c.agentOfflineQueued,
					sheet: 'commands',
					commandsOffline: true,
					connection: { kind: 'agent-offline' }
				},
				branch: 'Workspace offline'
			}
		]
	},
	{
		id: 'message-menu',
		code: 'MM',
		title: 'Actions under each message',
		intro:
			"Small icon buttons sit under each message: Copy, and Share where the phone can share. The newest reply always shows them; older messages show them on touch screens, and on hover or focus with a mouse. Copy takes the text as rendered, without markdown. Holding and right-clicking are the browser's own, so a hold selects text. Retry and Delete stay inline on your own unsent messages, and nothing here can approve anything.",
		frames: [
			{
				id: 'mm-1',
				label: 'Copy and Share under the reply',
				screen: ChatScreen,
				props: { messages: c.deliveryStates },
				next: 'Narrow phone'
			},
			{
				id: 'mm-3',
				label: 'At 320 wide',
				screen: ChatScreen,
				props: { messages: c.deliveryStates },
				width: 320,
				branch: 'Narrow phone'
			},
			{
				id: 'mm-d',
				label: 'Desktop: older rows appear on hover',
				screen: ChatScreen,
				props: { messages: c.deliveryStates },
				desktop: true
			}
		]
	},
	{
		id: 'files',
		code: 'FO',
		title: 'Files from the agent',
		intro:
			'Raster images (PNG, JPEG, GIF, WebP) show inline and open full screen in a sheet. Everything else is a download tile with no preview, including HTML, SVG and PDF.',
		frames: [
			{
				id: 'fo-1',
				label: 'Inline chart, download tiles, quota note',
				screen: ChatScreen,
				props: { messages: c.filesReply },
				next: 'Tap the chart',
				hits: { 'open image': 'fo-2' }
			},
			{
				id: 'fo-2',
				label: 'Image viewer sheet',
				screen: ChatScreen,
				props: {
					messages: c.filesReply,
					sheet: 'viewer',
					viewer: c.chartPng
				},
				hits: { close: 'fo-1' }
			},
			{
				id: 'fo-3',
				label: 'At 320: a 60-character filename wraps',
				screen: ChatScreen,
				props: { messages: c.filesReply },
				width: 320,
				branch: 'Narrow phone'
			}
		]
	},
	{
		id: 'push',
		code: 'PU',
		title: 'Notifications land on the item',
		intro:
			'A notification never carries action buttons. Tapping it opens the exact thing: the open tray, the question focused, the bottom of the chat, or the failed turn.',
		frames: [
			{
				id: 'pu-1',
				label: 'Approval needed',
				screen: HomeScreen,
				props: {},
				chrome: 'bare',
				notification: {
					title: 'Approval needed',
					body: 'sushii-agent needs your approval to run send_email'
				},
				next: 'Tap: Home opens its peek',
				hits: { agent: 'hm-2' }
			},
			{
				id: 'pu-2',
				label: 'The agent asks',
				screen: HomeScreen,
				props: {},
				chrome: 'bare',
				notification: { title: 'The agent asks', body: 'Aisle 24C or window 31K?' },
				branch: 'Lands on HM-5, the question in its peek',
				hits: { agent: 'hm-5' }
			},
			{
				id: 'pu-3',
				label: 'Reply finished while away',
				screen: HomeScreen,
				props: {},
				chrome: 'bare',
				notification: {
					title: 'Agent replied',
					body: 'Added. Brightline invoice INV-2291 is $1,240.00, due Sep 15, and is now row 38 in Budget 2026…'
				},
				branch: 'Lands on TU-6, the bottom of the chat',
				hits: { agent: 'tu-6' }
			},
			{
				id: 'pu-4',
				label: 'Turn interrupted',
				screen: HomeScreen,
				props: {},
				chrome: 'bare',
				notification: { title: 'Turn interrupted', body: 'The model provider timed out.' },
				branch: 'Lands on the failed turn',
				hits: { agent: 'pu-5' }
			},
			{
				id: 'pu-5',
				label: 'The interrupted turn',
				screen: ChatScreen,
				props: { messages: c.pushFailed, openTurn: 'v-a' },
				branch: 'Landing for PU-4'
			}
		]
	},
	{
		id: 'dm',
		code: 'DM',
		title: 'Discord DM retired',
		intro:
			'Owner DMs stop reaching the agent. Discord gets one line pointing at the app and no buttons, and the break-glass DM only says to open the app when a push could not be delivered.',
		frames: [
			{
				id: 'dm-1',
				label: 'Old habit: a DM to the bot',
				screen: DiscordDm,
				props: {
					lines: [
						{ from: 'you', text: 'What time is the dentist on Tuesday?', time: '09:12' },
						{ from: 'bot', text: 'Personal chat moved to https://agent.sushii.bot', time: '09:12' }
					]
				},
				chrome: 'bare',
				next: 'An approval can’t be pushed'
			},
			{
				id: 'dm-2',
				label: 'Break-glass DM',
				screen: DiscordDm,
				props: {
					lines: [
						{ from: 'bot', text: 'Personal chat moved to https://agent.sushii.bot', time: '09:12' },
						{ from: 'bot', text: 'An approval is pending. Open the app to decide.', time: '14:03' }
					]
				},
				chrome: 'bare',
				next: 'Open the app'
			},
			{
				id: 'dm-3',
				label: 'The app: the inline approval',
				screen: ChatScreen,
				props: {
					messages: c.hvacPending,
					running: true,
					approvals: [c.hvacApproval]
				}
			}
		]
	},
	...m5Flows,
	...m67Flows
];

// First match wins; a trailing * matches by prefix.
export const routes: [string, string][] = [...m23Routes, ...m4Routes, ...m5Routes, ...m67Routes];

export function frameFor(path: string): string | undefined {
	return routes.find(([p]) =>
		p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p
	)?.[1];
}

for (const flow of flows)
	for (const frame of flow.frames) frame.shell ??= frame.screen === ChatScreen;
