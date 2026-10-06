import { expect, test } from 'bun:test';
import {
	cacheGroup,
	retainedResponses,
	OFFLINE_MAX_BYTES,
	OFFLINE_TTL_MS,
	type CachedResponse
} from './offline-cache';
const row = (path: string, savedAt: number, bytes = 10): CachedResponse => ({
	path,
	group: cacheGroup(path)!,
	text: '{}',
	savedAt,
	bytes
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
test('TTL uses saved time and does not extend when browsing offline', () => {
	const now = OFFLINE_TTL_MS + 10;
	expect(
		retainedResponses([row('/chats', 10), row('/threads/a', 11)], now).map((r) => r.path)
	).toEqual(['/threads/a']);
});
test('retains 20 recent conversations and removes every page of the oldest', () => {
	const rows = Array.from({ length: 21 }, (_, i) => row(`/threads/${i}`, i + 1));
	rows.push(
		row('/threads/0/chat/history?limit=40', 1),
		row('/chats', 22),
		row('/chat/history?limit=40', 22)
	);
	const kept = retainedResponses(rows, 23);
	expect(kept.some((r) => r.group === 'thread:0')).toBe(false);
	expect(new Set(kept.filter((r) => r.group.startsWith('thread:')).map((r) => r.group)).size).toBe(
		20
	);
	expect(kept.filter((r) => !r.group.startsWith('thread:')).length).toBe(2);
});
test('byte budget evicts whole old conversations before newer ones', () => {
	const rows = [
		row('/threads/a', 1, OFFLINE_MAX_BYTES / 2),
		row('/threads/a/chat/history?limit=40', 2, 100),
		row('/threads/b', 3, OFFLINE_MAX_BYTES / 2)
	];
	expect(retainedResponses(rows, 4).map((r) => r.path)).toEqual(['/threads/b']);
});
