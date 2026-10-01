// Plays the takeover state flow on fixtures; nothing is streamed and nothing is locked.
import { fixtureDelay, fixtureScenario } from '$lib/core/fixtures';
import type { BrowserStatus } from './types';

export interface BrowserApi {
	status(): Promise<BrowserStatus>;
	takeOver(): Promise<BrowserStatus>;
	handBack(): Promise<BrowserStatus>;
}

export function browserFixture(
	now: number,
	holder: BrowserStatus['holder'] = 'agent'
): BrowserStatus {
	if (holder === 'idle') return { holder };
	return {
		holder,
		url: 'https://accounts.example.com/signin?continue=%2Fbilling',
		since: new Date(now - 2 * 60_000).toISOString(),
		task: { runId: '01K6B4D2F4H6K8M0P2R4T6V8X0', title: 'Download the September invoice' }
	};
}

export function createFixtureBrowserApi(): BrowserApi {
	let holder: BrowserStatus['holder'] = 'agent';
	async function gate() {
		const scenario = fixtureScenario('browser');
		await fixtureDelay(scenario);
		if (scenario === 'error') throw new Error("The agent's server didn't answer.");
		if (scenario === 'offline') throw new Error("Can't reach the agent right now.");
		if (scenario === 'empty') holder = 'idle';
	}
	return {
		async status() {
			await gate();
			return browserFixture(Date.now(), holder);
		},
		async takeOver() {
			await fixtureDelay('slow');
			holder = 'you';
			return { ...browserFixture(Date.now(), holder), since: new Date().toISOString() };
		},
		async handBack() {
			await fixtureDelay('normal');
			holder = 'agent';
			return { ...browserFixture(Date.now(), holder), since: new Date().toISOString() };
		}
	};
}
