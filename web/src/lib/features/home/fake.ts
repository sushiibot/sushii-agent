// Serves Home's fixtures until GET /api/home exists on the bot.
import { fixtureDelay, fixtureScenario } from '$lib/core/fixtures';
import type { HomeApi } from './api';
import { emptyHomeData, homeData } from './fixtures';

export const fixtureHomeApi: HomeApi = {
	async load() {
		const scenario = fixtureScenario('home');
		await fixtureDelay(scenario);
		if (scenario === 'error') throw new Error("The agent's server didn't answer.");
		const now = Date.now();
		if (scenario === 'empty') return emptyHomeData(now);
		if (scenario === 'offline' || scenario === 'unsupported') {
			return { ...emptyHomeData(now), workspace: { state: scenario } };
		}
		return homeData(now);
	},
	async dismiss() {
		await fixtureDelay('normal');
	}
};
