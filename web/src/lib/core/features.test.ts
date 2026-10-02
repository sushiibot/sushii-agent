/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { Features, parseOverride } from './features.svelte';

const never = () => new Promise<never>(() => {});

test('fixture overrides apply only to preview screens', () => {
	const previews = new Features(never, parseOverride('all'));
	for (const id of ['skills', 'schedules', 'browser', 'briefing'] as const) {
		expect(previews.has(id)).toBe(true);
	}
	expect(parseOverride('runs,history,threads,memory,connectors,nonsense')).toEqual(new Set());
	expect(parseOverride('browser, threads')).toEqual(new Set(['browser']));
	const normal = new Features(never, new Set());
	expect(normal.has('browser')).toBe(false);
	expect(normal.has(undefined)).toBe(true);
});

test('/api/me supplies dictation capability and concurrent loads share one request', async () => {
	let calls = 0;
	const capabilities = new Features(async () => {
		calls++;
		return { dictation: true };
	}, new Set());
	expect(capabilities.dictation).toBe(false);
	await Promise.all([capabilities.load(), capabilities.load()]);
	expect(capabilities.dictation).toBe(true);
	expect(capabilities.fresh).toBe(true);
	await capabilities.load();
	expect(calls).toBe(1);
});

test('a failed capability request retries without enabling dictation', async () => {
	let calls = 0;
	const capabilities = new Features(async () => {
		if (++calls === 1) throw new Error('offline');
		return { dictation: true };
	}, new Set());
	await capabilities.load();
	expect(capabilities.fresh).toBe(false);
	expect(capabilities.dictation).toBe(false);
	await capabilities.load();
	expect(capabilities.dictation).toBe(true);
	expect(capabilities.fresh).toBe(true);
});
