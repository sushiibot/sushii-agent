/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { homeData } from '$lib/features/home/fixtures';
import { RUNS, runDetailFull, runDetailPage, runSummaries, STEP_PAGE } from './fixtures';
import { RUN_ID_RE } from './types';

const NOW = Date.parse('2026-09-30T16:41:00Z');

test('fixture runs have real ids and every Home run opens in Runs', () => {
	for (const id of Object.values(RUNS)) expect(id).toMatch(RUN_ID_RE);
	const ids = new Set(runSummaries(NOW).map((r) => r.runId));
	const home = homeData(NOW);
	const online = home.workspace.state === 'online' ? home.workspace : null;
	for (const run of [
		...(online?.running ?? []),
		...(online?.failedRuns ?? []),
		...(online?.review ?? [])
	]) {
		expect(ids.has(run.runId)).toBe(true);
	}
	for (const alert of home.failed) if (alert.runId) expect(ids.has(alert.runId)).toBe(true);
});

test('parents start before their children', () => {
	const runs = runSummaries(NOW);
	for (const run of runs.filter((r) => r.parentRunId)) {
		const parent = runs.find((r) => r.runId === run.parentRunId)!;
		expect(Date.parse(parent.startedAt)).toBeLessThan(Date.parse(run.startedAt));
	}
});

test('steps page in order and evidence comes with the first page only', () => {
	const full = runDetailFull(NOW, RUNS.refactor)!;
	const first = runDetailPage(NOW, RUNS.refactor)!;
	expect(first.steps).toHaveLength(STEP_PAGE);
	expect(first.evidence).toBeDefined();
	const second = runDetailPage(NOW, RUNS.refactor, first.after!)!;
	expect(second.evidence).toBeUndefined();
	expect(second.after).toBeNull();
	expect([...first.steps, ...second.steps].map((s) => s.id)).toEqual(full.steps.map((s) => s.id));
	expect(runDetailPage(NOW, '01K6AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
});
