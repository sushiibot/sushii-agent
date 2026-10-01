// Until the M2/M3 routes exist on the bot, feature stores read typed fixtures through their fake
// APIs. This picks the state a fake serves, so tests and the dev server can show every one.
// localStorage `fixtures:<feature>` = empty | error | slow | offline | unsupported.

export type FixtureScenario = 'normal' | 'empty' | 'error' | 'slow' | 'offline' | 'unsupported';

const KNOWN = new Set<FixtureScenario>(['empty', 'error', 'slow', 'offline', 'unsupported']);

export function fixtureScenario(feature: string): FixtureScenario {
	try {
		const v = localStorage.getItem(`fixtures:${feature}`) as FixtureScenario | null;
		return v && KNOWN.has(v) ? v : 'normal';
	} catch {
		return 'normal';
	}
}

/** A short wait, or a long one for `slow`, so loading states can be seen. */
export function fixtureDelay(scenario: FixtureScenario): Promise<void> {
	return new Promise((r) => setTimeout(r, scenario === 'slow' ? 3000 : 120));
}
