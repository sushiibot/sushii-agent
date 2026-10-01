/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { searchFixtures } from './fixtures';
import { findRanges, highlightParts } from './highlight';

test('ranges count code points, so a match after an emoji is cut in the right place', () => {
	const text = '🚗 Book the car service at Eastside Auto';
	const ranges = findRanges(text, 'eastside');
	expect(ranges).toEqual([[26, 34]]);
	expect(highlightParts(text, ranges)).toEqual([
		{ text: '🚗 Book the car service at ', match: false },
		{ text: 'Eastside', match: true },
		{ text: ' Auto', match: false }
	]);
});

test('ranges outside the text, empty or overlapping are clipped, never thrown', () => {
	expect(highlightParts('abc', [[5, 9]])).toEqual([{ text: 'abc', match: false }]);
	expect(
		highlightParts('abcdef', [
			[1, 4],
			[2, 5]
		])
	).toEqual([
		{ text: 'a', match: false },
		{ text: 'bcd', match: true },
		{ text: 'e', match: true },
		{ text: 'f', match: false }
	]);
	expect(highlightParts('abc', [[1, 1]])).toEqual([{ text: 'abc', match: false }]);
});

test('fixture search finds both sources, newest first, with ranges on each snippet', () => {
	const now = Date.parse('2026-09-30T16:41:00Z');
	const result = searchFixtures(now, 'Eastside');
	expect(new Set(result.hits.map((h) => h.source))).toEqual(new Set(['chat', 'notes']));
	for (const hit of result.hits) {
		const [s, e] = hit.ranges[0];
		expect(Array.from(hit.snippet).slice(s, e).join('').toLowerCase()).toBe('eastside');
	}
	expect(searchFixtures(now, 'no such words').hits).toEqual([]);
});
