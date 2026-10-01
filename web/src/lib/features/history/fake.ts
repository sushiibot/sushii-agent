// Serves the History fixtures until /api/history exists on the bot.
import { fixtureDelay, fixtureScenario } from '$lib/core/fixtures';
import type { HistoryApi } from './api';
import { historyDay, historyDays, searchFixtures } from './fixtures';

const PAGE = 10;

function failure(scenario: string): Error | null {
	if (scenario === 'error') return new Error("The agent's server didn't answer.");
	if (scenario === 'offline') return new Error("Can't reach the agent right now.");
	if (scenario === 'unsupported') return new Error("History isn't available yet.");
	return null;
}

export const fixtureHistoryApi: HistoryApi = {
	async days({ before }) {
		const scenario = fixtureScenario('history');
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		if (scenario === 'empty') return { days: [], before: null };
		const all = historyDays(Date.now());
		const start = before ? all.findIndex((d) => d.date === before) + 1 : 0;
		const days = all.slice(start, start + PAGE);
		return { days, before: start + PAGE < all.length ? days.at(-1)!.date : null };
	},
	async day(date) {
		const scenario = fixtureScenario('history');
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		return historyDay(Date.now(), date);
	},
	async search(query) {
		const scenario = fixtureScenario('search');
		await fixtureDelay(scenario);
		if (scenario === 'error' || scenario === 'offline') throw failure(scenario)!;
		const result = searchFixtures(Date.now(), query);
		if (scenario === 'empty') return { ...result, hits: [] };
		if (scenario === 'truncated') return { ...result, truncated: true };
		// Run notes live in the workspace; chat is the bot's own, so it can answer alone.
		if (scenario === 'unsupported') {
			return {
				...result,
				hits: result.hits.filter((h) => h.source === 'chat'),
				unavailable: ['notes']
			};
		}
		return result;
	}
};
