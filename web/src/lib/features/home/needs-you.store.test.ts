/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { createHub } from '$lib/core/realtime/hub.svelte';
import { fakeTransport } from '$lib/core/realtime/fake-transport';
import type { JobAlert } from '$lib/core/realtime/events';
import type { ChatApi } from '$lib/features/chat';
import type { HomeApi } from './api';
import { homeData, nightlyAlert, RUN_IDS } from './fixtures';
import { NeedsYouStore } from './needs-you.svelte';
import type { HomeData } from './types';

const g = globalThis as unknown as { document?: unknown };
g.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

const NOW = Date.now();
const job: JobAlert = {
	source: 'job',
	job: 'nightly-sync',
	kind: 'failed',
	trigger: 'daily',
	startedAt: new Date(NOW).toISOString(),
	schedule: 'daily 02:00'
};

/** A Home API whose answers the test sets, counting loads. */
interface Server {
	data: HomeData | null;
	loads: number;
	dismissed: string[];
	opened: string[];
	api: HomeApi;
}

function server(first: HomeData | null = homeData(NOW)): Server {
	const s: Server = {
		data: first,
		loads: 0,
		dismissed: [] as string[],
		opened: [] as string[],
		api: {
			load: async () => {
				s.loads++;
				return s.data;
			},
			dismiss: async (id: string) => void s.dismissed.push(id),
			opened: async (id: string) => void s.opened.push(id)
		}
	};
	return s;
}

async function setup(first?: HomeData | null) {
	const stream = fakeTransport();
	const hub = createHub({ transport: stream.transport });
	const srv = server(first);
	const home = new NeedsYouStore({ hub, api: srv.api, chat: () => ({}) as ChatApi });
	home.open();
	await Bun.sleep(50);
	return { stream, hub, srv, home };
}

const ids = (home: NeedsYouStore) => Object.values(home.groups).flatMap((g) => g.map((i) => i.id));

test('run and alert events refetch the server part once per burst', async () => {
	const { stream, srv } = await setup();
	expect(srv.loads).toBe(1);
	stream.emit('run', { runId: RUN_IDS.flights, kind: 'subagent', status: 'done' }, false);
	stream.emit('alert', { key: 'o1', alert: job, text: 't' });
	stream.emit('alert_cleared', { id: 'job:other', reason: 'recovered' });
	await Bun.sleep(1200);
	expect(srv.loads).toBe(2);
});

test('a dismissed alert stays hidden until a load after the dismissal, then the server decides', async () => {
	const { home, srv } = await setup();
	expect(ids(home)).toContain('job:nightly-sync');
	await home.dismiss('job:nightly-sync');
	expect(srv.dismissed).toEqual(['job:nightly-sync']);
	expect(ids(home)).not.toContain('job:nightly-sync');
	// The bot drops it; then a later streak fails again and the bot lists it once more.
	srv.data = {
		...homeData(NOW),
		failed: homeData(NOW).failed.filter((a) => a.job !== 'nightly-sync')
	};
	await home.data.refetch();
	expect(ids(home)).not.toContain('job:nightly-sync');
	srv.data = homeData(NOW);
	await home.data.refetch();
	expect(ids(home)).toContain('job:nightly-sync');
});

test('alert_cleared hides the alert at once; a new failure for the job brings it back', async () => {
	const { home, stream, srv } = await setup();
	stream.emit('alert_cleared', { id: 'job:nightly-sync', reason: 'recovered' });
	await Bun.sleep(50);
	expect(ids(home)).not.toContain('job:nightly-sync');
	stream.emit('alert', { key: 'o2', alert: job, text: 't' });
	await Bun.sleep(50);
	expect(ids(home)).toContain('job:nightly-sync');
	srv.data = { ...homeData(NOW), failed: [nightlyAlert(NOW)] };
	await Bun.sleep(1200);
	expect(ids(home)).toContain('job:nightly-sync');
});

test('with Home off on the bot, the stream part still shows and nothing is posted', async () => {
	const { home, srv } = await setup(null);
	expect(home.data.status).toBe('ready');
	expect(home.data.data).toBeNull();
	home.markOpened(RUN_IDS.expenses);
	expect(srv.opened).toEqual([]);
	expect(home.groups.failed).toEqual([]);
});

test('opening a run posts it once and keeps it off review on this device', async () => {
	const { home, srv } = await setup();
	const review = home.groups.review.map((i) => i.id);
	expect(review.length).toBeGreaterThan(0);
	const runId = review[0]!.slice('run:'.length);
	home.markOpened(runId);
	home.markOpened(runId);
	await Bun.sleep(10);
	expect(srv.opened).toEqual([`run:${runId}`]);
	expect(home.groups.review.map((i) => i.id)).not.toContain(`run:${runId}`);
});
