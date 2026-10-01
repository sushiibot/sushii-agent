// Typed fixtures for the briefing. Made up.
import { toDate } from '$lib/ui/format/time';
import type { Briefing } from './types';

export function briefing(now: number): Briefing {
	const morning = new Date(now);
	morning.setHours(7, 30, 0, 0);
	return {
		date: toDate(now),
		at: morning.toISOString(),
		items: [
			{
				id: 'b-garage',
				section: 'top',
				title: 'The garage wants to service the car on Thursday',
				detail:
					'They offered Thursday 8am to noon and asked where to leave the keys. Not answered yet.',
				source: { label: 'Email from Eastside Auto' }
			},
			{
				id: 'b-review',
				section: 'top',
				title: 'notify-service #212 is waiting on your review',
				detail: 'Rate-limit fix for the feed poller. CI green, 14 files, +212 −88.',
				source: { label: 'GitHub pull request' }
			},
			{
				id: 'b-backup',
				section: 'top',
				title: 'Last night’s backup failed',
				detail: 'The backup server didn’t answer. Nothing was copied.',
				source: { label: 'Run · Back up projects', href: '/runs/01K6B2N8W3J5Q7R9T1V3X5Z7A9' }
			},
			{
				id: 'b-flight',
				section: 'ahead',
				title: 'FA 107 on Oct 9 at 11:05',
				detail: 'Check-in opens Oct 8 at 11:05. Seat not chosen.',
				source: { label: 'Email from the airline' }
			},
			{
				id: 'b-lease',
				section: 'ahead',
				title: 'Lease renewal notice due Dec 1',
				detail: 'The lease renews Mar 1, and notice is due 90 days before either way.',
				source: { label: 'Memory · MEMORY.md', href: '/memory/files/memory-md' }
			}
		]
	};
}
