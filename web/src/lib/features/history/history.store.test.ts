import { expect, test } from 'bun:test';
import { HistoryStore } from './history.svelte';
import type { HistoryApi } from './api';
import type { HistoryDay } from './types';

test('refresh retains older history, shifted head days and the deepest pagination cursor', async () => {
	const day = (n: number): HistoryDay => ({ date: `2026-09-${n}`, runs: 1, sessions: 1 });
	let head = [day(29), day(28)];
	const api: HistoryApi = {
		async days({ before }) {
			return before
				? { days: [day(27), day(26)], before: '2026-09-26' }
				: { days: head, before: head.at(-1)!.date };
		},
		async day() {
			return { found: false };
		},
		async search(query) {
			return { query, hits: [], unavailable: [], truncated: false };
		}
	};
	const store = new HistoryStore(api);
	await store.days.ensure();
	await store.loadOlder();
	head = [day(30), day(29)];
	await store.days.refetch();
	expect([...store.days.data!.days, ...store.older].map((d) => d.date)).toEqual([
		'2026-09-30',
		'2026-09-29',
		'2026-09-28',
		'2026-09-27',
		'2026-09-26'
	]);
	expect(store.before).toBe('2026-09-26');
	await store.days.refetch();
	expect(store.older).toHaveLength(3);
});
