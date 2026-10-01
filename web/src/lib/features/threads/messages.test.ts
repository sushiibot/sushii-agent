/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { chatStore } from '$lib/features/chat/store.svelte';
import { THREADS, threadDetail, tripReport } from './fixtures';
import { threadMessages, withReports } from './messages';

const NOW = Date.parse('2026-09-30T16:41:00Z');

test('a thread opens with its brief and puts each write under the reply that made it', () => {
	const d = threadDetail(NOW, THREADS.trip)!;
	const chat = d.history.map((h) => ({
		id: `h:${h.id}`,
		role: 'assistant' as const,
		parts: [{ type: 'text' as const, text: 'x' }]
	}));
	const out = threadMessages(d, chat);
	expect(out[0].parts[0].type).toBe('data-thread-brief');
	const writes = out.findIndex((m) => m.id === 'writes-h:trip-a1');
	expect(out[writes - 1].id).toBe('h:trip-a1');
	expect(out[writes].parts).toHaveLength(2);
});

test("Main lists closed threads' reports after its own messages", () => {
	const out = withReports([], [tripReport(NOW)]);
	expect(out.map((m) => m.parts[0].type)).toEqual(['data-thread-report']);
});

test('a thread without its own backend is refused instead of reading and posting to Main', () => {
	expect(() => chatStore('thread:anything')).toThrow();
});
