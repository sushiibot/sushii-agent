// Serves the Skills fixtures until the bot reads the workspace's skills. Changes last until reload.
import { fixtureDelay, fixtureScenario } from '$lib/core/fixtures';
import type { SkillsApi } from './api';
import { skillDetails } from './fixtures';
import type { SkillDetail } from './types';

function failure(scenario: string): Error | null {
	if (scenario === 'error') return new Error("The agent's server didn't answer.");
	if (scenario === 'offline') return new Error("Can't reach the agent right now.");
	if (scenario === 'unsupported') return new Error("Skills aren't available yet.");
	return null;
}

export function createFixtureSkillsApi(): SkillsApi {
	const changed = new Map<string, SkillDetail>();
	const all = () => skillDetails(Date.now()).map((s) => changed.get(s.name) ?? s);
	async function gate() {
		const scenario = fixtureScenario('skills');
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		return scenario;
	}
	return {
		async list() {
			const scenario = await gate();
			if (scenario === 'empty') return [];
			return all().map(({ why, history, runs, content, versions, ...s }) => s);
		},
		async get(name) {
			await gate();
			return all().find((s) => s.name === name) ?? null;
		},
		async setStage(name, stage) {
			await fixtureDelay('normal');
			const s = all().find((x) => x.name === name);
			if (!s) throw new Error('That skill is gone.');
			const next: SkillDetail = {
				...s,
				stage,
				why: stage === 'archived' ? 'Archived by you.' : 'Made active by you.',
				history: [
					{
						at: new Date().toISOString(),
						event: stage === 'archived' ? 'Archived' : 'Promoted to active',
						reason: 'By you, from the app.'
					},
					...s.history
				]
			};
			changed.set(name, next);
			return next;
		}
	};
}
