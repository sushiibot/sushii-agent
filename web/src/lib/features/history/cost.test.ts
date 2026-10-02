import { describe, expect, test } from 'bun:test';
import { costLabel } from './cost';

describe('History cost labels', () => {
	test('shows recorded dollars compactly and marks partial totals', () => {
		expect(costLabel({ usd: 1.235, recordedRuns: 3, unpricedRuns: 0 })).toBe('$1.24 cost');
		expect(costLabel({ usd: 0.0042, recordedRuns: 1, unpricedRuns: 2 })).toBe(
			'$0.0042 cost · partial'
		);
	});
	test('unknown pricing never looks free, and small known amounts do not round to zero', () => {
		expect(costLabel(undefined)).toBe('Cost unavailable');
		expect(costLabel({ usd: 0, recordedRuns: 0, unpricedRuns: 2 })).toBe('Cost unavailable');
		expect(costLabel({ usd: 0.00001, recordedRuns: 1, unpricedRuns: 0 })).toBe('<$0.0001 cost');
		expect(costLabel({ usd: 0, recordedRuns: 1, unpricedRuns: 0 })).toBe('$0.00 cost');
	});
});
