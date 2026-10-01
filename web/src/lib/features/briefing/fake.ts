// Serves the briefing fixture until the bot writes one. Votes and dismissals last until reload.
import { fixtureDelay, fixtureScenario, type FixtureScenario } from '../../core/fixtures';
import type { BriefingApi } from './api';
import { briefing } from './fixtures';

export function createFixtureBriefingApi(
	pick: () => FixtureScenario = () => fixtureScenario('briefing')
): BriefingApi {
	return {
		async today() {
			const scenario = pick();
			await fixtureDelay(scenario);
			if (scenario === 'error') throw new Error("The agent's server didn't answer.");
			if (scenario === 'offline') throw new Error("Can't reach the agent right now.");
			if (scenario === 'empty') return null;
			return briefing(Date.now());
		},
		async vote() {
			await fixtureDelay('normal');
		},
		async dismiss() {
			await fixtureDelay('normal');
		}
	};
}
