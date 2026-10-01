/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { createHub } from '$lib/core/realtime/hub.svelte';
import { fakeTransport } from '$lib/core/realtime/fake-transport';
import type { RunsApi } from './api';
import { RunsStore } from './runs.svelte';
import type { RunDetail, RunSummary } from './types';

const g = globalThis as unknown as { document?: unknown };
g.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

const id = (n: number) => `01K6B${String(n).padStart(21, '0')}`;
const run = (n: number, status: RunSummary['status'] = 'done'): RunSummary => ({
	runId: id(n),
	kind: 'subagent',
	agentName: 'explore',
	title: `run ${n}`,
	status,
	startedAt: new Date(1_790_000_000_000 + n * 60_000).toISOString()
});

function setup(all: RunSummary[], page = 3) {
	const calls = { list: 0, get: 0 };
	const api: RunsApi = {
		async list({ before }) {
			calls.list++;
			const sorted = [...all].sort((a, b) => (a.runId < b.runId ? 1 : -1));
			const start = before ? sorted.findIndex((r) => r.runId === before) + 1 : 0;
			const runs = sorted.slice(start, start + page);
			return {
				runs,
				before: start + page < sorted.length ? runs.at(-1)!.runId : null,
				truncated: false
			};
		},
		async get(runId) {
			calls.get++;
			const r = all.find((x) => x.runId === runId);
			return r
				? ({
						run: r,
						children: [],
						session: 'ok',
						steps: [],
						after: null,
						approvals: [],
						files: []
					} satisfies RunDetail)
				: null;
		}
	};
	const stream = fakeTransport();
	const store = new RunsStore(api, createHub({ transport: stream.transport }));
	store.start();
	return { store, stream, calls, all };
}

const shown = (s: RunsStore) => [...(s.list.data?.runs ?? []), ...s.older].map((r) => r.title);

test("a run event updates the run's status in the list and in its open detail", async () => {
	const { store, stream, all } = setup([run(1), run(2), run(3, 'running')]);
	await store.list.refetch();
	const view = store.run(id(3));
	await view.remote.refetch();
	all[2] = { ...all[2]!, status: 'failed', endedAt: new Date().toISOString() };
	stream.emit('run', { runId: id(3), kind: 'subagent', status: 'failed' }, false);
	await Bun.sleep(50);
	expect(store.list.data?.runs[0]).toMatchObject({ runId: id(3), status: 'failed' });
	expect(view.remote.data?.run.status).toBe('failed');
	await Bun.sleep(1200);
	expect(view.remote.data?.run.endedAt).toBeDefined();
});

test('a new run joins the top of the list without losing older pages or repeating any', async () => {
	const { store, stream, all } = setup([1, 2, 3, 4, 5, 6].map((n) => run(n)));
	await store.list.refetch();
	await store.loadOlder();
	expect(shown(store)).toEqual(['run 6', 'run 5', 'run 4', 'run 3', 'run 2', 'run 1']);
	all.push(run(7, 'running'));
	stream.emit('run', { runId: id(7), kind: 'subagent', status: 'running' }, false);
	await Bun.sleep(1200);
	expect(shown(store)).toEqual(['run 7', 'run 6', 'run 5', 'run 4', 'run 3', 'run 2', 'run 1']);
	expect(store.before).toBeNull();
});
