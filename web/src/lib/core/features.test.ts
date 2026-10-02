/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { Features, parseOverride } from './features.svelte';

const never = () => new Promise<never>(() => {});

test('a bot feature is never off while /api/me is unknown, and off once it says so', async () => {
	const f = new Features(async () => ({ features: ['home'] }), null, new Set());
	expect(f.off('runs')).toBe(false);
	await f.load();
	expect(f.off('runs')).toBe(true);
	expect(f.has('home')).toBe(true);
});

test('a client feature shows only through the override, and is off without it', () => {
	const off = new Features(never, null, new Set());
	expect(off.has('browser')).toBe(false);
	expect(off.off('browser')).toBe(true);
	const on = new Features(never, null, parseOverride('browser, threads'));
	expect(on.has('browser')).toBe(true);
	expect(on.off('browser')).toBe(false);
	expect(on.has('skills')).toBe(false);
});

test('the override can turn on a bot feature the bot left off', async () => {
	const f = new Features(async () => ({ features: [] }), null, parseOverride('all'));
	await f.load();
	expect(f.off('runs')).toBe(false);
	expect(parseOverride('nonsense,runs')).toEqual(new Set(['runs']));
});
