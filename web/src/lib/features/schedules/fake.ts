// Serves the Schedules fixtures until the bot exposes its jobs. Changes last until reload.
import { fixtureDelay, fixtureScenario, type FixtureScenario } from '../../core/fixtures';
import type { SchedulesApi } from './api';
import { jobDetails } from './fixtures';
import type { JobDetail } from './types';

function failure(scenario: string): Error | null {
	if (scenario === 'error') return new Error("The agent's server didn't answer.");
	if (scenario === 'offline') return new Error("Can't reach the agent right now.");
	if (scenario === 'unsupported') return new Error("Schedules aren't available yet.");
	return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createFixtureSchedulesApi(
	pick: () => FixtureScenario = () => fixtureScenario('schedules')
): SchedulesApi {
	const changed = new Map<string, JobDetail>();
	const all = () => jobDetails(Date.now()).map((j) => changed.get(j.id) ?? j);
	async function gate() {
		const scenario = pick();
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		return scenario;
	}
	return {
		async list() {
			const scenario = await gate();
			return scenario === 'empty' ? [] : all().map(({ prompt, runs, ...j }) => j);
		},
		async get(id) {
			await gate();
			return all().find((j) => j.id === id) ?? null;
		},
		async setEnabled(id, enabled) {
			await fixtureDelay('normal');
			const j = all().find((x) => x.id === id);
			if (!j) throw new Error('That job is gone.');
			const next = {
				...j,
				enabled,
				nextRun: enabled ? new Date(Date.now() + 30 * 60_000).toISOString() : null
			};
			changed.set(id, next);
			return next;
		},
		async testRun(id, onstep) {
			const steps = [
				'Starting the job with sending off',
				'Running step 2 of about 4',
				'Checking the result'
			];
			for (const step of steps) {
				onstep({ state: 'running', step });
				await sleep(700);
			}
			return id === 'nightly-sync'
				? {
						state: 'done',
						result: 'failed',
						note: 'Still can’t reach the backup server. Nothing was sent.'
					}
				: { state: 'done', result: 'sent', note: 'Would have sent a message. Nothing was sent.' };
		}
	};
}
