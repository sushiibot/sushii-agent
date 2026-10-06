// M4 flows: the Conversations list and thread chats, on the threads feature's fixtures.
import { ChatScreen, type ChatMessage } from '$lib/features/chat';
import { ChatsScreen, ThreadScreen, threadMessages } from '$lib/features/threads';
import * as t from '$lib/features/threads/fixtures';
import WithBranch from './components/with-branch.svelte';
import type { Flow, Frame } from './flows';

const NOW = new Date(2026, 8, 30, 16, 41).getTime();
const ready = { status: 'ready' } as const;
const chats = t.chatsData(NOW);
const tabs = { shell: true, tabBar: true, tab: 'chat', badges: { home: 2 } } as const;
const detail = { shell: true, tab: 'chat' } as const;
const back = { href: '/chats', label: 'Back to Conversations' };

const history = (id: string): ChatMessage[] =>
	t.threadDetail(NOW, id)!.history.flatMap((h): ChatMessage[] =>
		h.type === 'user' || h.type === 'assistant'
			? [
					{
						id: `h:${h.id}`,
						role: h.type,
						parts: [
							...(h.type === 'assistant' && h.tools.length
								? [
										{
											type: 'data-turn' as const,
											data: {
												state: 'done' as const,
												elapsed: '9s',
												steps: h.tools.map((x, i) => ({
													id: `${h.id}-${i}`,
													tool: x.name,
													label: x.summary,
													state: 'ok' as const,
													input: '{}'
												}))
											}
										}
									]
								: []),
							{ type: 'text' as const, text: h.text }
						]
					}
				]
			: []
	);

const thread = (
	id: string,
	props: Record<string, unknown> = {},
	chat: Record<string, unknown> = {}
) => {
	const d = t.threadDetail(NOW, id)!;
	return {
		remote: ready,
		detail: d,
		now: NOW,
		back,
		chat: { messages: threadMessages(d, history(id)), ...chat },
		...props
	};
};
const archivedTrip = () => {
	const d = t.threadDetail(NOW, t.THREADS.trip)!;
	return {
		...d,
		summary: {
			...d.summary,
			state: 'archived' as const,
			archived: { at: new Date(NOW - 60_000).toISOString(), by: 'you' as const }
		}
	};
};
const couch = t.threadDetail(NOW, t.THREADS.couch)!;
const list = (props: Record<string, unknown> = {}) => ({
	remote: ready,
	data: chats,
	now: NOW,
	onnew: () => {},
	...props
});
const mainProps = (messages: ChatMessage[], props: Record<string, unknown> = {}) => ({
	messages,
	back,
	onbranch: () => {},
	onstartthread: () => {},
	...props
});

const chatsFrames: Frame[] = [
	{
		id: 'cs-1',
		label: 'Conversations: Main pinned, grouped by activity',
		screen: ChatsScreen,
		props: list(),
		...tabs,
		next: 'Search',
		hits: { main: 'th-1', 'october trip': 'th-3', 'new thread': 'th-6' }
	},
	{
		id: 'cs-2',
		label: 'Searching',
		screen: ChatsScreen,
		props: list({ query: 'trip' }),
		...tabs,
		tabBar: false,
		keyboard: ['trip', 'trips', 'tripped']
	},
	{
		id: 'cs-3',
		label: 'Archived threads, at the end of the list',
		screen: ChatsScreen,
		props: list(),
		...tabs,
		scrollTo: 600,
		branch: 'Scrolled down',
		hits: { 'couch delivery': 'cl-4' }
	},
	{
		id: 'cs-4',
		label: 'No threads yet',
		screen: ChatsScreen,
		props: list({ data: t.emptyChatsData(NOW) }),
		...tabs,
		branch: 'Before the first thread'
	},
	{
		id: 'cs-5',
		label: 'Loading, slowly',
		screen: ChatsScreen,
		props: list({ remote: { status: 'loading', slow: true }, data: undefined }),
		...tabs,
		branch: 'Slow network'
	},
	{
		id: 'cs-6',
		label: "Couldn't load",
		screen: ChatsScreen,
		props: list({
			remote: { status: 'error', error: "The agent's server didn't answer." },
			data: undefined
		}),
		...tabs,
		branch: 'The server fails'
	},
	{
		id: 'cs-7',
		label: 'Offline',
		screen: ChatsScreen,
		props: list({ online: false }),
		...tabs,
		branch: 'Phone offline'
	}
];

const threadFrames: Frame[] = [
	{
		id: 'th-1',
		label: 'Main offers a thread',
		screen: ChatScreen,
		props: mainProps(t.mainWithOffer),
		...detail,
		next: 'Start conversation',
		hits: { 'start thread': 'th-2' }
	},
	{
		id: 'th-2',
		label: 'The thread opens from a brief',
		screen: ThreadScreen,
		props: thread(
			t.THREADS.trip,
			{},
			{
				messages: threadMessages(
					t.threadDetail(NOW, t.THREADS.trip)!,
					history(t.THREADS.trip).slice(0, 1)
				)
			}
		),
		...detail,
		next: 'Chat in the thread'
	},
	{
		id: 'th-3',
		label: 'Working in the thread',
		screen: ThreadScreen,
		props: thread(t.THREADS.trip),
		...detail,
		next: 'Tap “Shares memory”',
		hits: { 'shares memory': 'th-4', archive: 'cl-1' }
	},
	{
		id: 'th-4',
		label: 'Writes from this thread',
		screen: ThreadScreen,
		props: thread(t.THREADS.trip, { sheet: 'thread-memory' }),
		...detail
	},
	{
		id: 'th-5',
		label: 'Typing in a thread',
		screen: ThreadScreen,
		props: thread(t.THREADS.trip, {}, { draft: 'Aisle, 24C' }),
		...detail,
		keyboard: ['24C', 'Aisle', 'aisle'],
		branch: 'Keyboard up'
	},
	{
		id: 'th-6',
		label: 'Start a conversation from a reply',
		screen: WithBranch,
		props: mainProps(t.mainWithOffer, {
			branch: {
				quote:
					'Three fit: the inn (19k), the loft hotel (23k) and the ryokan (24.5k with breakfast). Want me to check cancellation terms?',
				title: 'Hotel choice'
			}
		}),
		...detail,
		branch: 'Or tap the thread button under any reply',
		hits: { 'start thread': 'th-2', cancel: 'th-1' }
	},
	{
		id: 'th-7',
		label: 'Main after the move',
		screen: ChatScreen,
		props: mainProps(t.mainOfferTaken),
		...detail,
		branch: 'Main keeps a link to the thread'
	}
];

const closeFrames: Frame[] = [
	{
		id: 'cl-1',
		label: 'Archive without ending the conversation',
		screen: ThreadScreen,
		props: thread(t.THREADS.trip, { sheet: 'thread-close' }),
		...detail,
		next: 'Archive conversation',
		hits: { 'archive thread': 'cl-2', 'keep current': 'th-3' }
	},
	{
		id: 'cl-2',
		label: 'Archived stays visible below current threads',
		screen: ChatsScreen,
		props: list({
			data: {
				...chats,
				threads: chats.threads.map((t) =>
					t.id === archivedTrip().summary.id ? archivedTrip().summary : t
				)
			}
		}),
		...tabs,
		next: 'Continue the thread',
		hits: { 'october trip': 'cl-3' }
	},
	{
		id: 'cl-3',
		label: 'Archived thread: send a message to continue',
		screen: ThreadScreen,
		props: { ...thread(t.THREADS.trip), detail: archivedTrip() },
		...detail
	},
	{
		id: 'cl-4',
		label: 'Archived by itself after a quiet week',
		screen: ThreadScreen,
		props: {
			...thread(t.THREADS.couch),
			detail: couch,
			chat: { messages: threadMessages(couch, history(t.THREADS.couch)) }
		},
		...detail,
		branch: 'Auto-archive: nothing new for 7 days'
	},
	{
		id: 'cl-5',
		label: 'No such thread',
		screen: ThreadScreen,
		props: { remote: ready, detail: null, now: NOW, back },
		...detail,
		branch: 'A stale link'
	}
];

export const m4Flows: Flow[] = [
	{
		id: 'chats',
		code: 'CS',
		title: 'Conversations: Main and ongoing topics',
		intro:
			'Main is the general-purpose hub. Persistent topic threads group by activity, and inactive ones move into the visible Archived section after seven days. Every thread stays available to resume.',
		frames: chatsFrames
	},
	{
		id: 'thread',
		code: 'TH',
		title: 'Start and work in a thread',
		intro:
			'Main offers to move a topic that keeps coming back, or you start one from the thread button under any reply. The thread starts from a brief, not the whole history, and shares memory with Main.',
		frames: threadFrames
	},
	{
		id: 'close',
		code: 'CL',
		title: 'Archive and resume a thread',
		intro:
			'Archiving moves a thread below current conversations while keeping its history and composer available. Sending a message resumes the same thread. Ordinary threads do not report to Main.',
		frames: closeFrames
	}
];

export const m4Routes: [string, string][] = [
	[`/chats/${t.THREADS.couch}`, 'cl-4'],
	[`/chats/${t.THREADS.trip}`, 'th-3'],
	['/chats/*', 'th-3'],
	['/chats', 'cs-1']
];
