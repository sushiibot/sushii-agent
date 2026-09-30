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
import DiscordDm from './components/discord-dm.svelte';
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
	/** An Android heads-up notification over the screen; tapping it follows `hits`. */
	notification?: { title: string; body: string; when?: string };
	/** Fixed phone width, whatever the board toggle says. */
	width?: number;
	/** Start the chat scrolled this many px up from the newest message. */
	scrollUp?: number;
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
		title: 'Approvals sit in a pinned tray, not in the chat',
		detail:
			'UXG puts the approval card in the message list. M1 pins it above the composer, outside the scroll, and leaves a one-line marker in the chat that becomes the decision.',
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
			'The UI never expires the tray itself. When the bot reports a timeout, the tray reads "Timed out, denied" for a few seconds, then folds into its chat marker, which stays in history.',
		flow: 'chat'
	},
	{
		id: 4,
		title: 'Approve is disabled for 1s after the tray appears or moves',
		detail:
			'Deny sits on the left and is the smaller target. Approve shows a visible held state with a line of text, so the tap does not read as broken.',
		flow: 'chat'
	}
];

const archivedTrip: Session = { ...f.tripSession, state: 'archived' };

export const flows: Flow[] = [
	{
		id: 'install',
		code: 'IN',
		title: 'Install and first launch',
		intro:
			'iOS has no install prompt, so a Safari tab shows a quiet hint. The installed app opens full screen. Notifications are asked for only after you tap "Enable notifications", which says what will ring.',
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
				label: 'First launch: notifications not asked',
				screen: NeedsYou,
				props: { items: f.inbox, hint: 'push' },
				next: 'Tap Enable notifications',
				hits: { 'enable notifications': 'in-4' }
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
					toast: 'Notifications on. Approvals, questions, failures, and replies while you are away.'
				}
			},
			{
				id: 'in-6',
				label: 'Blocked in settings, with steps',
				screen: NeedsYou,
				props: { items: f.inbox, hint: 'push', push: 'denied' },
				branch: 'Don’t allow, or blocked earlier'
			},
			{
				id: 'in-7',
				label: 'Unsupported browser',
				screen: NeedsYou,
				props: { items: f.inbox, hint: 'push', push: 'unsupported' },
				chrome: 'safari',
				branch: 'No Push API in this browser'
			},
			{
				id: 'in-8',
				label: 'Persistent hint while notifications are off',
				screen: NeedsYou,
				props: { items: f.inbox, hint: 'push-off' },
				branch: 'Hint dismissed but still off'
			}
		]
	},
	{
		id: 'needs-you',
		code: 'NY',
		title: 'Home: needs you',
		intro:
			'Grouped by what blocks progress, not by time. Approvals (shield) and questions (the agent’s voice) list first and count in the tab badge. Tapping one opens it in the chat and never answers it. Failed and running items still peek in a sheet.',
		deviations: [1],
		frames: [
			{
				id: 'ny-1',
				label: 'Home: 2 approvals, 1 question',
				screen: NeedsYou,
				props: { items: f.inbox },
				next: 'Tap an approval',
				hits: { 'weekly dependency': 'ny-2' }
			},
			{
				id: 'ny-2',
				label: 'A failed run peeks in a sheet',
				screen: NeedsYou,
				props: { items: f.inbox, peek: 'in-deploy-fail' },
				branch: 'Tap a failed run'
			},
			{
				id: 'ny-d',
				label: 'Desktop: list and peek side by side',
				screen: NeedsYou,
				props: { items: f.inbox, peek: 'in-deploy-fail' },
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
			'Four tabs: Home, Chats, Briefing, More. The tab bar shows only on those four screens. More holds this device’s notification settings: status and a test send.',
		frames: [
			{ id: 'nv-1', label: 'More, notifications off', screen: More, props: {} },
			{
				id: 'nv-2',
				label: 'Notifications on, test sent',
				screen: More,
				props: { push: 'granted', testSent: true },
				branch: 'After enabling'
			}
		]
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
			'The agent drafts an email and asks to send it. The request pins above the composer in a shielded tray that the chat can’t imitate; the chat keeps a one-line marker that turns into the decision. While the tray is up, Stop moves to the ⋮ menu so the chat keeps half the screen; Send still steers the run.',
		deviations: [1, 2, 3, 4],
		frames: [
			{
				id: 'ch-1',
				label: 'Working: Send steers, Stop sits apart',
				screen: Chat,
				props: { session: f.mainSession, messages: f.hvacWorking, running: true },
				next: 'Asks to send'
			},
			{
				id: 'ch-2',
				label: 'Tray appears, Approve held for 1s',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.hvacPending,
					running: true,
					tray: { items: [f.hvacApproval], armed: false },
					waiting: 3
				},
				next: 'After 1s'
			},
			{
				id: 'ch-3',
				label: 'Ready to decide',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.hvacPending,
					running: true,
					tray: { items: [f.hvacApproval] },
					waiting: 3
				},
				next: 'Approve',
				hits: { approve: 'ch-4', deny: 'ch-6', 'show details': 'ch-11' }
			},
			{
				id: 'ch-4',
				label: 'Submitting',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.hvacPending,
					running: true,
					tray: { items: [f.hvacApproval], state: 'submitting' },
					waiting: 3
				},
				next: 'Bot confirms'
			},
			{
				id: 'ch-5',
				label: 'Approved, sent with evidence',
				screen: Chat,
				props: { session: f.mainSession, messages: f.hvacApproved, openTurn: 'h2' }
			},
			{
				id: 'ch-6',
				label: 'Denied',
				screen: Chat,
				props: { session: f.mainSession, messages: f.hvacDenied },
				branch: 'Deny from CH-3'
			},
			{
				id: 'ch-7',
				label: 'Two approvals stacked, and a question',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.twoApprovalsAndAsk,
					running: true,
					tray: { items: [f.hvacApproval, f.prApproval] },
					waiting: 3
				},
				branch: 'Several pending: the tray says 1 of 2; the question stays in the chat'
			},
			{
				id: 'ch-8',
				label: 'Decided on another device',
				screen: Chat,
				props: { session: f.mainSession, messages: f.hvacElsewhere },
				branch: 'Approved on the laptop: the tray closes, the marker says where'
			},
			{
				id: 'ch-9',
				label: 'Timed out, denied',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.hvacTimedOut,
					tray: { items: [f.hvacApproval], state: 'timeout' }
				},
				branch: 'Nobody decided in 30 min: the bot denies, the tray says so',
				next: 'After about 3s'
			},
			{
				id: 'ch-12',
				label: 'Folded into the chat marker',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.hvacTimedOut,
					tray: { items: [f.hvacApproval], state: 'timeout', collapsed: true }
				},
				branch: 'The tray folds away; the marker keeps the outcome'
			},
			{
				id: 'ch-10',
				label: 'A reply that imitates an approval',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.spoofReply,
					running: true,
					tray: { items: [f.hvacApproval] },
					waiting: 3
				},
				branch:
					'Spoof: markdown with a heading, bold “Approve” and a link; no buttons, next to the real tray'
			},
			{
				id: 'ch-11',
				label: 'Show details: the exact input',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.hvacPending,
					running: true,
					tray: { items: [f.hvacApproval], details: true },
					waiting: 3
				},
				hits: { approve: 'ch-4', deny: 'ch-6', 'hide details': 'ch-3' },
				branch: 'Show details from CH-3: every field, scrolling inside the tray'
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
				screen: Chat,
				props: { session: f.mainSession, messages: f.askThread(f.seatAsk), focusAsk: 'seat-107' },
				next: 'Tap Aisle 24C',
				hits: { 'aisle 24c': 'as-2' }
			},
			{
				id: 'as-2',
				label: 'Sending the answer',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.askThread({ ...f.seatAsk, state: 'answering', answer: 'Aisle 24C' })
				},
				next: 'Delivered'
			},
			{
				id: 'as-3',
				label: 'Answered',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.askThread({ ...f.seatAsk, state: 'answered', answer: 'Aisle 24C' }),
					running: true
				}
			},
			{
				id: 'as-4',
				label: 'Answered on another device',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.askThread({ ...f.seatAsk, state: 'elsewhere', answer: 'Window 31K' })
				},
				branch: 'Answered on the laptop first'
			},
			{
				id: 'as-5',
				label: 'In history: inert',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.askThread({ ...f.seatAsk, state: 'history', answer: 'Aisle 24C' })
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
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnStarted, running: true },
				next: 'No token for 2s'
			},
			{
				id: 'tu-2',
				label: 'Thinking, never a bare spinner',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnThinking, running: true },
				next: 'Tools run'
			},
			{
				id: 'tu-3',
				label: 'Current step, count, one failed',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnFailedStep, running: true },
				next: 'Tap the row'
			},
			{
				id: 'tu-4',
				label: 'Expanded: steps, then exact input and output',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.turnFailedStep,
					running: true,
					openTurn: 'v-a',
					openStep: 'v3'
				},
				next: 'First delta'
			},
			{
				id: 'tu-5',
				label: 'Streaming into a reserved bubble',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnStreaming, running: true },
				next: 'Turn ends'
			},
			{
				id: 'tu-6',
				label: 'Final reply; screen reader hears “Agent replied” once',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnDone, announce: 'Agent replied' }
			},
			{
				id: 'tu-7',
				label: 'Scrolled up: New messages pill',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.turnStreamingLong,
					running: true,
					newMessages: true
				},
				scrollUp: 260,
				branch: 'Reading older messages while it streams; nothing moves'
			},
			{
				id: 'tu-8',
				label: 'Stopping…',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnStopping, running: true, stopping: true },
				branch: 'Tap Stop mid-stream',
				next: 'Stopped'
			},
			{
				id: 'tu-9',
				label: 'Stopped by you, partial text kept',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnStopped },
				branch: 'The turn ends where it was'
			},
			{
				id: 'tu-10',
				label: 'Nothing to stop',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.nothingToStop,
					connection: { kind: 'agent-offline' },
					toast: 'Nothing to stop. The agent is offline.'
				},
				branch: 'Stop from the command menu while the agent is offline'
			},
			{
				id: 'tu-11',
				label: 'Typing mid-run: Send steers it',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.turnFailedStep,
					running: true,
					typing: 'Only the 2024 invoices, skip the rest'
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
				screen: Chat,
				props: { session: f.mainSession, messages: f.deliveryStates }
			},
			{
				id: 'dl-2',
				label: 'Offline: queued',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.offlineQueued,
					connection: { kind: 'offline' }
				},
				branch: 'The phone lost its connection'
			},
			{
				id: 'dl-3',
				label: 'Reconnecting, with elapsed time',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.turnStreaming,
					running: true,
					connection: { kind: 'reconnecting', elapsed: '12s' }
				},
				branch: 'Back on the network: it resumes by itself'
			},
			{
				id: 'dl-4',
				label: 'The agent is offline',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.agentOfflineQueued,
					connection: { kind: 'agent-offline' }
				},
				branch: 'The phone is online, the workspace is not; no fallback agent answers'
			},
			{
				id: 'dl-5',
				label: 'Reloaded after a long absence',
				screen: Chat,
				props: { session: f.mainSession, messages: f.resetReloaded, connection: { kind: 'reset' } },
				branch: 'Away longer than the live buffer'
			},
			{
				id: 'dl-6',
				label: 'History: dividers, unverified, unavailable',
				screen: Chat,
				props: { session: f.mainSession, messages: f.historyItems },
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
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.turnDone,
					photos: f.photoDrafts,
					typing: 'Which of these fits the hallway?'
				},
				next: 'Some fail'
			},
			{
				id: 'ph-2',
				label: 'Failed, unsupported, too large',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnDone, photos: f.photoFailures },
				next: 'Retry and send'
			},
			{
				id: 'ph-3',
				label: 'Sent inline; a deleted photo says so',
				screen: Chat,
				props: { session: f.mainSession, messages: f.photosSent }
			},
			{
				id: 'ph-4',
				label: 'Photo storage full',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnDone, quotaFull: true },
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
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnDone, sheet: 'commands' },
				next: 'New chat',
				hits: { 'new chat': 'cm-2', compact: 'cm-5' }
			},
			{
				id: 'cm-2',
				label: 'Confirm a new chat',
				screen: Chat,
				props: { session: f.mainSession, messages: f.turnDone, sheet: 'new' },
				next: 'Start new chat',
				hits: { 'start new chat': 'cm-3', cancel: 'cm-1' }
			},
			{
				id: 'cm-3',
				label: 'Starting a new chat',
				screen: Chat,
				props: { session: f.mainSession, messages: f.newChatStarting, running: true },
				next: 'Ready'
			},
			{
				id: 'cm-4',
				label: 'New chat divider',
				screen: Chat,
				props: { session: f.mainSession, messages: f.newChatStarted }
			},
			{
				id: 'cm-5',
				label: 'Compacting',
				screen: Chat,
				props: { session: f.mainSession, messages: f.compacting, running: true },
				branch: 'Compact from the sheet',
				next: 'Done'
			},
			{
				id: 'cm-6',
				label: 'Compacted, summary expanded',
				screen: Chat,
				props: { session: f.mainSession, messages: f.compacted, openTurn: 'c2' },
				branch: 'The divider opens to the summary'
			},
			{
				id: 'cm-7',
				label: 'Commands while the agent is offline',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.agentOfflineQueued,
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
		title: 'Hold a message for its actions',
		intro:
			'Holding a message, or right-clicking it on desktop, opens its actions in a sheet that Back closes. The ⋯ button under each message opens the same sheet. Copy takes the text as rendered, without markdown. Retry and Delete appear only on your own unsent messages, and nothing here can approve anything.',
		frames: [
			{
				id: 'mm-1',
				label: 'Hold an agent reply',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.deliveryStates,
					sheet: 'message',
					pressed: 'd1r'
				},
				next: 'Your failed message'
			},
			{
				id: 'mm-2',
				label: 'Hold your failed message',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.deliveryStates,
					sheet: 'message',
					pressed: 'd2'
				},
				branch: 'Retry and Delete join the list'
			},
			{
				id: 'mm-3',
				label: 'At 320 wide',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.deliveryStates,
					sheet: 'message',
					pressed: 'd1r'
				},
				width: 320,
				branch: 'Narrow phone'
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
				screen: Chat,
				props: { session: f.mainSession, messages: f.filesReply },
				next: 'Tap the chart',
				hits: { 'open image': 'fo-2' }
			},
			{
				id: 'fo-2',
				label: 'Image viewer sheet',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.filesReply,
					sheet: 'viewer',
					viewer: f.chartPng
				},
				hits: { close: 'fo-1' }
			},
			{
				id: 'fo-3',
				label: 'At 320: a 60-character filename wraps',
				screen: Chat,
				props: { session: f.mainSession, messages: f.filesReply },
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
				next: 'Tap',
				hits: { agent: 'ch-2' }
			},
			{
				id: 'pu-2',
				label: 'The agent asks',
				screen: HomeScreen,
				props: {},
				chrome: 'bare',
				notification: { title: 'The agent asks', body: 'Aisle 24C or window 31K?' },
				branch: 'Lands on AS-1, card in view and focused',
				hits: { agent: 'as-1' }
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
				screen: Chat,
				props: { session: f.mainSession, messages: f.pushFailed, openTurn: 'v-a' },
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
				label: 'The app: the pending tray',
				screen: Chat,
				props: {
					session: f.mainSession,
					messages: f.hvacPending,
					running: true,
					tray: { items: [f.hvacApproval] },
					waiting: 3
				}
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
	['/chats/main?approve=*', 'ch-2'],
	['/chats/main?ask=*', 'as-1'],
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
	['/memory/mc5', 'ms-1'],
	['/memory/mc6', 'ms-1'],
	['/memory/mc7', 'ms-1'],
	['/memory/*', 'ms-2'],
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
