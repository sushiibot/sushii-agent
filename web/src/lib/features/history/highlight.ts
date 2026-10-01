import type { Range } from './types';

/**
 * Splits a snippet into plain and matched parts. Ranges count code points, so the text is
 * split by code point, never by UTF-16 unit. Ranges outside the text or overlapping are clipped.
 */
export function highlightParts(
	text: string,
	ranges: readonly Range[]
): { text: string; match: boolean }[] {
	const cps = Array.from(text);
	const out: { text: string; match: boolean }[] = [];
	let at = 0;
	for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
		const start = Math.max(at, Math.min(s, cps.length));
		const end = Math.max(start, Math.min(e, cps.length));
		if (end === start) continue;
		if (start > at) out.push({ text: cps.slice(at, start).join(''), match: false });
		out.push({ text: cps.slice(start, end).join(''), match: true });
		at = end;
	}
	if (at < cps.length) out.push({ text: cps.slice(at).join(''), match: false });
	return out;
}

/** Every case-insensitive occurrence of `query` in `text`, as code-point ranges. */
export function findRanges(text: string, query: string, max = 5): Range[] {
	const cps = Array.from(text.toLowerCase());
	const q = Array.from(query.toLowerCase());
	const out: Range[] = [];
	for (let i = 0; i + q.length <= cps.length && out.length < max; i++) {
		if (q.every((c, j) => cps[i + j] === c)) {
			out.push([i, i + q.length]);
			i += q.length - 1;
		}
	}
	return out;
}
