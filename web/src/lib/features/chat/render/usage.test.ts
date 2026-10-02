/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { aggregateCost, formatCost, shortModel, usageLine } from './usage';

test('aggregate costs distinguish free, unknown, partial and bounded totals', () => {
	expect(aggregateCost(undefined)).toBe('Unavailable');
	expect(aggregateCost({ usd: 0, recordedRuns: 0, unpricedRuns: 0 })).toBe('$0');
	expect(aggregateCost({ usd: 0, recordedRuns: 0, unpricedRuns: 2 })).toBe('Unavailable');
	expect(aggregateCost({ usd: 0, recordedRuns: 1, unpricedRuns: 0 })).toBe('$0');
	expect(aggregateCost({ usd: 0.0024, recordedRuns: 2, unpricedRuns: 1 })).toBe(
		'$0.0024 · partial'
	);
	expect(aggregateCost({ usd: 1.23, recordedRuns: 2, unpricedRuns: 0 }, true)).toBe(
		'$1.23 · partial'
	);
	expect(aggregateCost({ usd: 0.00001, recordedRuns: 1, unpricedRuns: 0 })).toBe('<$0.0001');
});

test('model ids lose their provider prefix', () => {
	expect(shortModel('openrouter/deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
	expect(shortModel('claude-sonnet-5')).toBe('claude-sonnet-5');
	expect(shortModel('vendor/')).toBe('vendor');
});

test('costs keep enough digits to be worth reading', () => {
	expect(formatCost(0.0123)).toBe('$0.012');
	expect(formatCost(0.00042)).toBe('$0.0004');
	expect(formatCost(1.5)).toBe('$1.50');
	expect(formatCost(0)).toBe('$0');
});

test('the line shows model, context and cost, skipping what the reply lacks', () => {
	expect(
		usageLine({
			model: 'openrouter/deepseek/deepseek-v4.1-flash',
			inputTokens: 1000,
			outputTokens: 200,
			contextPct: 34.4,
			costUsd: 0.0123
		})
	).toBe('deepseek-v4.1-flash · ctx 34% · $0.012');
	expect(usageLine({ model: 'm', inputTokens: 1, outputTokens: 1 })).toBe('m');
});
