// Serves the Runs fixtures until /api/runs exists on the bot.
import { fixtureDelay, fixtureScenario } from '$lib/core/fixtures';
import type { RunsApi } from './api';
import { runDetailPage, runSummaries } from './fixtures';

const PAGE = 10;

function failure(scenario: string): Error | null {
	if (scenario === 'error') return new Error("The agent's server didn't answer.");
	if (scenario === 'offline') return new Error("Can't reach the agent right now.");
	if (scenario === 'unsupported') return new Error("Runs aren't available yet.");
	return null;
}

export const fixtureRunsApi: RunsApi = {
	async list({ before, kinds }) {
		const scenario = fixtureScenario('runs');
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		if (scenario === 'empty') return { runs: [], before: null, truncated: false };
		const all = runSummaries(Date.now()).filter((r) => !kinds || kinds.includes(r.kind));
		const start = before ? all.findIndex((r) => r.runId === before) + 1 : 0;
		const runs = all.slice(start, start + PAGE);
		const more = start + PAGE < all.length;
		return { runs, before: more ? runs.at(-1)!.runId : null, truncated: !more && !!before };
	},
	async get(runId, q = {}) {
		const scenario = fixtureScenario('runs');
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		return runDetailPage(Date.now(), runId, q.after);
	}
};
