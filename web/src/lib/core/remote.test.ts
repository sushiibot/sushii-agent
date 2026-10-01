/// <reference types="bun" />
import { afterEach, expect, test } from 'bun:test';
import { Remote } from './remote.svelte';

const g = globalThis as unknown as { document?: unknown };
const real = g.document;
afterEach(() => {
	g.document = real;
});

test('focus refetching listens only while a screen watches', () => {
	const listeners = new Set<unknown>();
	g.document = {
		visibilityState: 'visible',
		addEventListener: (_: string, fn: unknown) => listeners.add(fn),
		removeEventListener: (_: string, fn: unknown) => listeners.delete(fn)
	};
	const r = new Remote(async () => 1, { refetchOnFocus: true });
	expect(listeners.size).toBe(0);
	const a = r.watch();
	const b = r.watch();
	expect(listeners.size).toBe(1);
	a();
	a();
	expect(listeners.size).toBe(1);
	b();
	expect(listeners.size).toBe(0);
	expect(new Remote(async () => 1).watch).toBeDefined();
});
