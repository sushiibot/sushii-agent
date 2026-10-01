// Typed fixtures for Memory, shared by the fake API, the prototype board and tests. Made up.
import type { MemoryFile, MemoryWriteRecord } from './types';

const MIN = 60_000;
const iso = (now: number, minsAgo: number) => new Date(now - minsAgo * MIN).toISOString();

/** Run ids from the Runs fixtures, so "Written by" opens a real fixture run. */
const RUN = {
	invoice: '01K6B4A0C2E4G6J8M0P2R4T6V8',
	flush: '01K6AZQ7S9V1X3Z5B7D9F1H3K5',
	hoa: '01K6AY4C6E8G0J2M4P6R8T0W2Y',
	refactor: '01K6AZT2V4X6Z8B0D2F4H6K8M0'
};

export const WRITES = {
	trip: 'w-hotels',
	seat: 'w-seat',
	vendor: 'w-vendor',
	thursday: 'w-thursday',
	skill: 'w-skill',
	daily: 'w-daily'
} as const;

export function memoryFiles(now: number): MemoryFile[] {
	return [
		{
			id: 'memory-md',
			path: 'MEMORY.md',
			about: 'The index: who is who, standing facts, where things live',
			updatedAt: iso(now, 100),
			lines: 4,
			content: [
				'## People',
				'- **Eastside Auto**: the garage. Invoices by email; prefers email for scheduling.',
				'',
				'## Home',
				'- Lease renews on March 1. Notice is due 90 days before.'
			].join('\n')
		},
		{
			id: 'user-md',
			path: 'USER.md',
			about: 'How you like things done',
			updatedAt: iso(now, 57),
			lines: 4,
			content: [
				'## Schedule',
				'- Avoid meetings before 09:30, and before 10:00 on Thursdays.',
				'',
				'## Travel',
				'- Aisle seat on flights over 6 hours.'
			].join('\n')
		},
		{
			id: 'travel-2026-10-trip-md',
			path: 'travel/2026-10-trip.md',
			about: 'The October trip: what is booked, what is open',
			updatedAt: iso(now, 58),
			lines: 3,
			content: [
				'## Hotels (Oct 9–16, under 25k)',
				'- The ryokan, 24.5k with breakfast, free to cancel until Oct 6',
				'- The inn, 19k, free to cancel until Oct 7'
			].join('\n')
		},
		{
			id: 'daily-2026-09-29-md',
			path: 'daily/2026-09-29.md',
			about: "Yesterday's notes",
			updatedAt: iso(now, 26 * 60),
			lines: 2,
			content: '- Flight FA 107 booked for Oct 9; seat not chosen.\n- Rent receipt filed.'
		}
	];
}

export function memoryWrites(now: number): MemoryWriteRecord[] {
	const trip = { id: 'oct-trip', title: 'October trip' };
	return [
		{
			id: WRITES.trip,
			fileId: 'travel-2026-10-trip-md',
			path: 'travel/2026-10-trip.md',
			summary: 'Hotel shortlist, with cancellation dates',
			at: iso(now, 58),
			commit: 'a51c0e2',
			thread: trip,
			diff: [
				{ kind: 'add', text: '## Hotels (Oct 9–16, under 25k)' },
				{ kind: 'add', text: '- The ryokan, 24.5k with breakfast, free to cancel until Oct 6' },
				{ kind: 'add', text: '- The inn, 19k, free to cancel until Oct 7' }
			]
		},
		{
			id: WRITES.seat,
			fileId: 'user-md',
			path: 'USER.md',
			summary: 'Prefers an aisle seat on flights over 6 hours',
			at: iso(now, 57),
			commit: '3c9d1f0',
			thread: trip,
			diff: [
				{ kind: 'ctx', text: '## Travel' },
				{ kind: 'add', text: '- Aisle seat on flights over 6 hours.' }
			]
		},
		{
			id: WRITES.vendor,
			fileId: 'memory-md',
			path: 'MEMORY.md',
			summary: 'Added: Eastside Auto prefers email for scheduling',
			at: iso(now, 100),
			commit: '7f3c2a1',
			run: { id: RUN.invoice, title: "What's the invoice from Eastside Auto about?" },
			taint: 'The run had read an outside email',
			diff: [
				{ kind: 'ctx', text: '## People' },
				{
					kind: 'add',
					text: '- **Eastside Auto**: the garage. Invoices by email; prefers email for scheduling.'
				}
			]
		},
		{
			id: WRITES.thursday,
			fileId: 'user-md',
			path: 'USER.md',
			summary: 'Changed: no meetings before 10:00 on Thursdays',
			at: iso(now, 101),
			commit: '1ab9e04',
			run: { id: RUN.invoice, title: "What's the invoice from Eastside Auto about?" },
			diff: [
				{ kind: 'ctx', text: '## Schedule' },
				{ kind: 'del', text: '- Avoid meetings before 09:30.' },
				{ kind: 'add', text: '- Avoid meetings before 09:30, and before 10:00 on Thursdays.' }
			]
		},
		{
			id: WRITES.daily,
			fileId: 'daily-2026-09-29-md',
			path: 'daily/2026-09-29.md',
			summary: 'Daily note: flight booked, seat not chosen',
			at: iso(now, 26 * 60),
			commit: 'c2290fe',
			run: { id: RUN.flush, title: 'Save notes to memory before the session compacts' },
			diff: [
				{ kind: 'add', text: '- Flight FA 107 booked for Oct 9; seat not chosen.' },
				{ kind: 'add', text: '- Rent receipt filed.' }
			]
		},
		{
			id: WRITES.skill,
			fileId: 'memory-md',
			path: 'MEMORY.md',
			summary: 'Removed: the old garage’s phone line',
			at: iso(now, 3 * 24 * 60),
			commit: 'e04d7b9',
			run: { id: RUN.hoa, title: 'Summarise the HOA meeting notes' },
			diff: [
				{ kind: 'ctx', text: '## People' },
				{ kind: 'del', text: '- Old garage: call before 5pm.' }
			],
			reverted: { at: iso(now, 2 * 24 * 60), commit: '9d1e3aa' }
		}
	];
}
