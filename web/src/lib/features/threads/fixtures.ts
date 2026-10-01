// Typed fixtures for Chats and threads, shared by the fake API, the prototype board and tests.
// Everything here is made up: no real people, places or bookings.
import type { WebHistoryItem } from '$lib/core/realtime/events';
import type { ChatMessage } from '$lib/features/chat';
import { ago } from '$lib/ui/format/time';
import type { ChatsData, MainSummary, ThreadDetail, ThreadReport, ThreadSummary } from './types';

const MIN = 60_000;
const iso = (now: number, minsAgo: number) => new Date(now - minsAgo * MIN).toISOString();

export const THREADS = {
	trip: 'oct-trip',
	review: 'pr-212',
	lease: 'lease',
	taxes: 'taxes',
	bike: 'bike',
	couch: 'couch',
	passport: 'passport'
} as const;

export function mainSummary(now: number): MainSummary {
	return {
		lastActivity: iso(now, 2),
		preview: 'While you were out: rent receipt filed, dependency sweep failed.',
		unread: 1,
		state: 'idle'
	};
}

export function threadSummaries(now: number): ThreadSummary[] {
	return [
		{
			id: THREADS.trip,
			title: 'October trip',
			state: 'needs-you',
			lastActivity: iso(now, 38),
			preview: 'Aisle 24C or window 31K?',
			writes: 2
		},
		{
			id: THREADS.review,
			title: 'notify-service #212 review',
			state: 'running',
			lastActivity: iso(now, 0.5),
			preview: 'Reading 14 changed files',
			writes: 0
		},
		{
			id: THREADS.lease,
			title: 'Lease renewal',
			state: 'idle',
			lastActivity: iso(now, 26 * 60),
			preview: 'Drafted the 90-day notice. Not sent.',
			unread: 2,
			writes: 1
		},
		{
			id: THREADS.taxes,
			title: '2026 taxes',
			state: 'idle',
			lastActivity: iso(now, 2 * 24 * 60),
			preview: 'Collected 9 of 12 documents.',
			writes: 3
		},
		{
			id: THREADS.bike,
			title: 'Bike fitting',
			state: 'idle',
			lastActivity: iso(now, 6 * 24 * 60),
			preview: 'Booked Saturday 10:00 at the bike shop.',
			writes: 1
		},
		{
			id: THREADS.couch,
			title: 'Couch delivery',
			state: 'archived',
			lastActivity: iso(now, 11 * 24 * 60),
			preview: 'Delivered on the 12th. Reported to Main.',
			writes: 1,
			archived: { at: iso(now, 4 * 24 * 60), by: 'idle' }
		},
		{
			id: THREADS.passport,
			title: 'Passport renewal',
			state: 'archived',
			lastActivity: iso(now, 27 * 24 * 60),
			preview: 'New passport arrived. Reported to Main.',
			writes: 2,
			archived: { at: iso(now, 26 * 24 * 60), by: 'you' }
		}
	];
}

export function chatsData(now: number): ChatsData {
	return { main: mainSummary(now), threads: threadSummaries(now), cap: 8, archiveAfterDays: 7 };
}

export function emptyChatsData(now: number): ChatsData {
	return { ...chatsData(now), threads: [] };
}

const tripBrief: ThreadDetail['brief'] = {
	known: [
		'Flight FA 107 on Oct 9 is booked. Seat not picked.',
		'Seven nights in the city, hotel under 25k a night.',
		'Skipping the second city, so no rail pass.'
	],
	open: [
		'Which of the three hotels',
		'Cancellation terms for each',
		'Seat: aisle 24C or window 31K'
	],
	recentFromMain: 6
};

function history(now: number, id: string, title: string): WebHistoryItem[] {
	if (id === THREADS.trip) {
		return [
			{
				type: 'assistant',
				id: 'trip-a0',
				at: iso(now, 70),
				text: 'Picking up the trip here. Main stays for everything else. Where do you want to start?',
				tools: [],
				files: []
			},
			{
				type: 'user',
				id: 'trip-u1',
				at: iso(now, 60),
				text: 'Check cancellation for the inn and the ryokan. Aisle seat, always.',
				attachments: []
			},
			{
				type: 'assistant',
				id: 'trip-a1',
				at: iso(now, 58),
				text: 'The ryokan is free to cancel until Oct 6, the inn until Oct 7. I saved both, and noted aisle seats for long flights.',
				tools: [
					{ name: 'read_page', summary: 'Read the ryokan’s cancellation policy', ok: true },
					{ name: 'read_page', summary: 'Read the inn’s cancellation policy', ok: true }
				],
				files: []
			},
			{
				type: 'assistant',
				id: 'trip-a2',
				at: iso(now, 38),
				text: 'One more thing before check-in opens: aisle 24C or window 31K?',
				tools: [],
				files: []
			}
		];
	}
	return [
		{
			type: 'assistant',
			id: `${id}-a0`,
			at: iso(now, 90),
			text: `Picking up ${title} here. Main stays for everything else.`,
			tools: [],
			files: []
		}
	];
}

export function threadDetail(now: number, id: string): ThreadDetail | null {
	const summary = threadSummaries(now).find((t) => t.id === id);
	if (!summary) return null;
	const when = (mins: number) => ago(iso(now, mins), now);
	const writes: ThreadDetail['writes'] =
		id === THREADS.trip
			? [
					{
						id: 'w-hotels',
						file: 'travel/2026-10-trip.md',
						summary: 'Hotel shortlist, with cancellation dates',
						when: when(58),
						session: { id, title: summary.title },
						after: 'h:trip-a1'
					},
					{
						id: 'w-seat',
						file: 'USER.md',
						summary: 'Prefers an aisle seat on flights over 6 hours',
						when: when(57),
						session: { id, title: summary.title },
						after: 'h:trip-a1'
					}
				]
			: [];
	return {
		summary,
		brief:
			id === THREADS.trip
				? tripBrief
				: { known: [`${summary.title}: what Main knew`], open: [], recentFromMain: 0 },
		writes,
		history: history(now, id, summary.title),
		closing: {
			writes: [
				...writes,
				{
					id: 'w-close',
					file: 'travel/2026-10-trip.md',
					summary: 'Trip summary: what is booked and what is still open',
					when: 'on close',
					session: { id, title: summary.title }
				}
			],
			line:
				id === THREADS.trip
					? 'Flight FA 107 booked, seat 24C. Hotel still open: the ryokan or the inn, free to cancel until Oct 6.'
					: `${summary.preview}`
		}
	};
}

/** Main's offer to move a topic, before and after you take it. */
const offer = {
	title: 'October trip',
	reason:
		'The trip came up in 9 of your last 14 messages. A thread keeps hotels, flights and bookings together and keeps Main short.'
};

export const mainWithOffer: ChatMessage[] = [
	{
		id: 'm1',
		role: 'user',
		parts: [{ type: 'text', text: 'Find hotels near the river for Oct 9–16, under 25k a night.' }]
	},
	{
		id: 'm2',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: 'Three fit: the inn (19k), the loft hotel (23k) and the ryokan (24.5k with breakfast). Want me to check cancellation terms?'
			}
		]
	},
	{
		id: 'm3',
		role: 'user',
		parts: [
			{ type: 'text', text: 'Yes. And is the rail pass still worth it if we skip the second city?' }
		]
	},
	{
		id: 'm4',
		role: 'assistant',
		parts: [
			{
				type: 'text',
				text: 'Without the second city, single tickets come to about 14k less than the pass, so skip it.'
			},
			{ type: 'data-thread-offer', data: offer }
		]
	}
];

export const mainOfferTaken: ChatMessage[] = mainWithOffer.map((m) =>
	m.id === 'm4'
		? {
				...m,
				parts: [
					m.parts[0],
					{ type: 'data-thread-offer', data: { ...offer, openedAs: THREADS.trip } }
				]
			}
		: m
);

export function tripReport(now: number): ThreadReport {
	return {
		sessionId: THREADS.trip,
		title: 'October trip',
		line: threadDetail(now, THREADS.trip)!.closing.line
	};
}
