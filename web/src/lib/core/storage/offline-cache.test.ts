import { expect, test } from 'bun:test';
import {
	cacheGroup,
	retainedResponses,
	OFFLINE_MAX_BYTES,
	type CachedResponse
} from './offline-cache';
const row = (path: string, savedAt: number, bytes = 10, usedAt?: number): CachedResponse => ({
	path,
	group: cacheGroup(path)!,
	text: '{}',
	savedAt,
	bytes,
	usedAt
});
test('only thread metadata and conversation history can be cached', () => {
	for (const path of [
		'/chats',
		'/threads/a',
		'/threads/a/chat/history?limit=40',
		'/chat/history?limit=40&before=a'
	])
		expect(cacheGroup(path)).not.toBeNull();
	for (const path of [
		'/me',
		'/models',
		'/threads/a/chat/stream',
		'/threads/a/close',
		'/uploads/a',
		'/threads/a?other=1'
	])
		expect(cacheGroup(path)).toBeNull();
});
test('all threads and old snapshots remain cached while they fit', () => {
	const rows = Array.from({ length: 100 }, (_, i) => row(`/threads/${i}`, 0));
	expect(retainedResponses(rows)).toEqual(rows);
});
test('size pressure evicts old pages individually, without a per-thread limit', () => {
	const rows = [
		row('/threads/a', 2, OFFLINE_MAX_BYTES / 2),
		row('/threads/a/chat/history?limit=40', 1, 100),
		row('/threads/b', 3, OFFLINE_MAX_BYTES / 2)
	];
	expect(retainedResponses(rows).map((r) => r.path)).toEqual(['/threads/a', '/threads/b']);
});
test('recently read pages outlive older background downloads', () => {
	const rows = [
		row('/threads/a', 1, OFFLINE_MAX_BYTES / 2, 100),
		row('/threads/b', 90, OFFLINE_MAX_BYTES / 2, 2),
		row('/chats', 100, 10)
	];
	expect(retainedResponses(rows).map((r) => r.path)).toEqual(['/threads/a', '/chats']);
});
