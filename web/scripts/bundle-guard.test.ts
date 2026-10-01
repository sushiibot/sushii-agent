import { describe, expect, test } from 'bun:test';
import { bundleViolations, forbiddenModules } from './bundle-guard';

const root = '/home/u/web';

describe('forbiddenModules', () => {
	test('flags every fake API, fixture file and the fake transport', () => {
		const ids = [
			`${root}/src/lib/features/home/fake.ts`,
			`${root}/src/lib/features/runs/fixtures.ts`,
			`${root}/src/lib/core/fixtures.ts`,
			`${root}/src/lib/core/realtime/fake-transport.ts`,
			`${root}/src/lib/features/chat/fake.ts?v=123`
		];
		expect(forbiddenModules(ids)).toHaveLength(5);
	});

	test('passes the real API, stores and look-alike names', () => {
		const ids = [
			`${root}/src/lib/features/home/api.ts`,
			`${root}/src/lib/features/runs/runs.svelte.ts`,
			`${root}/src/lib/features/history/fixtures.test.ts`,
			`${root}/src/lib/features/chat/fake-ish.ts`,
			`${root}/node_modules/some-lib/fake.ts`
		];
		expect(forbiddenModules(ids)).toEqual([]);
	});

	test('matches Windows paths too', () => {
		expect(forbiddenModules(['C:\\web\\src\\lib\\features\\home\\fake.ts'])).toHaveLength(1);
	});
});

test('bundleViolations names the chunk and ignores assets', () => {
	const bundle = {
		'a.js': {
			type: 'chunk' as const,
			fileName: 'a.js',
			moduleIds: [`${root}/src/lib/core/http.ts`]
		},
		'b.js': {
			type: 'chunk' as const,
			fileName: 'b.js',
			moduleIds: [`${root}/src/lib/features/runs/fake.ts`]
		},
		'c.css': { type: 'asset' as const, fileName: 'c.css' }
	};
	expect(bundleViolations(bundle)).toEqual([`b.js: ${root}/src/lib/features/runs/fake.ts`]);
});
