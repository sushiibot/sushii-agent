/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { nextRunLine } from './format';

const NOW = new Date(2026, 8, 30, 16, 41).getTime();
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

test('the next-run line counts down, then names the day, and says when a job is paused', () => {
	expect(nextRunLine({ enabled: true, nextRun: at(19) }, NOW)).toBe('Next run in 19 min');
	expect(nextRunLine({ enabled: true, nextRun: at(120) }, NOW)).toMatch(/^Next run today /);
	expect(nextRunLine({ enabled: true, nextRun: at(15 * 60) }, NOW)).toMatch(/^Next run tomorrow /);
	expect(nextRunLine({ enabled: false, nextRun: null }, NOW)).toBe('Paused, no next run');
});
