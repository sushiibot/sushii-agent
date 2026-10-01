// The app build the suite runs against (playwright.config.ts builds it first) must carry no fixture
// data and no fake backend: they are for /proto, this suite and `bun dev` with ?fake.
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_IDS } from '../src/lib/features/home/fixtures';
import { RUNS } from '../src/lib/features/runs/fixtures';

const BUILD = join(import.meta.dirname, '..', 'build');

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : /\.(js|html)$/.test(name) ? [path] : [];
	});
}

test('the production build contains no fixtures or fakes', () => {
	const markers = [
		...Object.values(RUN_IDS),
		...Object.values(RUNS),
		// chat/fake.ts's scripted reply, core/fixtures.ts's storage key, the dev ?fake installer.
		'Eastside Auto',
		'fixtures:',
		'installFakes'
	];
	const all = files(BUILD);
	expect(all.length).toBeGreaterThan(5);
	const found = all.flatMap((path) => {
		const text = readFileSync(path, 'utf8');
		return markers.filter((m) => text.includes(m)).map((m) => `${path}: ${m}`);
	});
	expect(found).toEqual([]);
});
