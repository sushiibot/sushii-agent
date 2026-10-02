import { describe, expect, test } from 'bun:test';
import { RunActivityCache, latestActivity } from './activity';
import type { RunDetail, RunStep } from './types';
const run = {
	runId: '01K6B2N8W3J5Q7R9T1V3X5Z7A9',
	kind: 'subagent' as const,
	agentName: 'coder',
	title: 'Work',
	status: 'running' as const,
	startedAt: '2026-10-01T00:00:00Z'
};
const step = (i: number): RunStep => ({
	id: `s${i}`,
	type: 'assistant',
	at: run.startedAt,
	text: `Activity ${i}`
});
const page = (steps: RunStep[], after: string | null): RunDetail => ({
	run,
	steps,
	after,
	children: [],
	session: 'ok',
	approvals: [],
	files: []
});

describe('shared incremental background activity', () => {
	test('polls overlap parallel pending tools until both same-id results settle', async () => {
		const cursors: (string | undefined)[] = [];
		const first: RunStep = {
			id: 'tool1',
			type: 'tool',
			at: run.startedAt,
			name: 'read_file',
			args: 'routes.ts',
			ok: null,
			result: ''
		};
		const second: RunStep = { ...first, id: 'tool2', args: 'store.ts' };
		const cache = new RunActivityCache(async (_id, after) => {
			cursors.push(after);
			const steps =
				cursors.length === 1
					? [step(1), first, second]
					: cursors.length === 2
						? [{ ...first, ok: true, result: 'Finished reading routes.' }, second]
						: cursors.length === 3
							? [{ ...second, ok: true, result: 'Finished reading store.' }]
							: [];
			return page(steps, null);
		});
		await cache.read(run.runId);
		const firstSettled = await cache.read(run.runId);
		expect(cursors).toEqual([undefined, 's1']);
		expect(firstSettled.steps.find((step) => step.id === 'tool1')).toMatchObject({
			ok: true,
			result: 'Finished reading routes.'
		});
		const bothSettled = await cache.read(run.runId);
		expect(cursors.at(-1)).toBe('tool1');
		expect(bothSettled.steps.at(-1)).toMatchObject({
			id: 'tool2',
			ok: true,
			result: 'Finished reading store.'
		});
		await cache.read(run.runId);
		expect(cursors.at(-1)).toBe('tool2');
	});
	test('reaches activity past the first 100 steps and an empty poll retains the latest step', async () => {
		const cursors: (string | undefined)[] = [];
		const cache = new RunActivityCache(async (_id, after) => {
			cursors.push(after);
			if (!after)
				return page(
					Array.from({ length: 100 }, (_, i) => step(i + 1)),
					's100'
				);
			if (after === 's100') return page([step(101)], null);
			return page([], null);
		});
		const first = await cache.read(run.runId);
		expect(cursors).toEqual([undefined, 's100']);
		expect(latestActivity(first.steps)).toBe('Activity 101');
		expect(first.steps).toHaveLength(100);
		const empty = await cache.read(run.runId);
		expect(cursors.at(-1)).toBe('s101');
		expect(latestActivity(empty.steps)).toBe('Activity 101');
		expect(empty.steps).toEqual(first.steps);
	});
	test('cards and the sheet coalesce concurrent reads and each poll has a bounded page budget', async () => {
		let calls = 0;
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cache = new RunActivityCache(async () => {
			const i = ++calls;
			await held;
			return page([step(i)], `s${i}`);
		});
		const card = cache.read(run.runId),
			sheet = cache.read(run.runId);
		expect(card).toBe(sheet);
		release();
		const [first, second] = await Promise.all([card, sheet]);
		expect(calls).toBe(3);
		expect(second).toBe(first);
		expect(latestActivity(first.steps)).toBe('Activity 3');
		const next = await cache.read(run.runId);
		expect(calls).toBe(6);
		expect(latestActivity(next.steps)).toBe('Activity 6');
	});
	test('a later run-state update with no steps preserves activity and tool labels remain readable', async () => {
		let calls = 0;
		const tool: RunStep = {
			id: 'tool1',
			type: 'tool',
			at: run.startedAt,
			name: 'read_file',
			args: 'routes.ts',
			ok: null,
			result: ''
		};
		const cache = new RunActivityCache(async () =>
			++calls === 1 ? page([tool], null) : { ...page([], null), run: { ...run, status: 'done' } }
		);
		await cache.read(run.runId);
		const done = await cache.read(run.runId);
		expect(done.run.status).toBe('done');
		expect(latestActivity(done.steps)).toBe('read file');
	});
});
