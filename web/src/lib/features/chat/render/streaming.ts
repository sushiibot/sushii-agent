import {
	exceedsParseLimits,
	parseMarkdown,
	parseTopLevel,
	type MdBlockNode,
	type MdInlineNode,
	type RenderContext,
	type TopLevelBlock
} from './markdown';

// Incremental rendering of a reply that is still streaming. Finished top-level blocks are parsed
// once and reused by identity; only the tail is parsed again. The display-only edits below run on
// the text after the last blank line, so they can never reach a block that has been kept.

/** A link or footnote definition changes how earlier text renders, so its reply is re-parsed whole.
 *  Each alternative starts on a different character and the label class excludes newlines, so
 *  nothing backtracks past one line. Definitions nested in quotes and list items count too. */
const DEFINITION_RE = /^(?:[ \t>]|[-*+][ \t]|\d{1,9}[.)][ \t])*\[[^\]\n]+\]:/m;
/** A top-level definition still being typed shows as a paragraph that vanishes once it completes. */
const DEFINITION_START_RE = /^ {0,3}\[[^\]\n]+\]:/;
/** Unclosed emphasis past this many openers is left raw rather than closed for display. */
const CLOSERS_MAX = 8;

/** One tail parse slower than this drops the rest of the stream to plain text until it ends. */
export const STREAM_PARSE_BUDGET_MS = 50;
/** Rendered updates (parse, DOM and layout) slower than this, two frames, several times in a row
 *  also drop to plain text; one sample alone is too noisy to act on. */
export const STREAM_FRAME_BUDGET_MS = 32;
const SLOW_FRAMES_MAX = 3;
/** After a parse, wait this many times its cost before the next one, so slow input can't hog frames. */
export const STREAM_BACKOFF = 4;

const plainOf = (text: string): MdBlockNode => ({ kind: 'plain', text });

const sameBlock = (a: MdBlockNode, b: MdBlockNode) =>
	a === b || JSON.stringify(a) === JSON.stringify(b);

export class MarkdownStream {
	#key: string | null = null;
	#source = '';
	#stable: MdBlockNode[] = [];
	#text: string | null = null;
	#final = false;
	#tree: MdBlockNode[] = [];
	#overBudget = false;
	#noReuse = false;
	#slowFrames = 0;
	readonly #view: (tail: string) => string;
	/** `performance.now()` before which a new parse isn't worth starting. */
	nextAt = 0;
	/** Cost of the last parse, in ms. */
	lastMs = 0;

	/** `view` turns the raw tail into what is shown; tests pass the identity to check reuse alone. */
	constructor(view: (tail: string) => string = streamingView) {
		this.#view = view;
	}

	/** How many leading blocks are kept and no longer re-parsed. */
	get kept(): number {
		return this.#stable.length;
	}

	#reset(key: string) {
		this.#key = key;
		this.#source = '';
		this.#stable = [];
		this.#overBudget = false;
		this.#noReuse = false;
		this.#slowFrames = 0;
	}

	/** The render tree for a reply still streaming. Same input, same array. */
	update(text: string, ctx: RenderContext, key = ''): MdBlockNode[] {
		if (!this.#final && this.#text === text && this.#key === key) return this.#tree;
		// Streaming only appends; anything else is a different reply and starts over.
		if (key !== this.#key || !text.startsWith(this.#text ?? '')) this.#reset(key);
		this.#final = false;
		this.#text = text;
		if (this.#overBudget || exceedsParseLimits(text)) return (this.#tree = [plainOf(text)]);

		const t0 = performance.now();
		if (DEFINITION_RE.test(text)) this.#noReuse = true;
		if (this.#noReuse) {
			this.#source = '';
			this.#stable = [];
		}
		let tail = text.slice(this.#source.length);
		let shown = this.#view(tail);
		// Display edits add closers, so the shown text needs its own check against the limits.
		let nodes = exceedsParseLimits(shown) ? null : parseTopLevel(shown, ctx);
		// A definition the pattern missed (multi-line label): kept blocks may reference it.
		if (nodes?.some((n) => n.definition) && !this.#noReuse) {
			this.#noReuse = true;
			if (this.#source) {
				this.#source = '';
				this.#stable = [];
				tail = text;
				shown = this.#view(tail);
				nodes = exceedsParseLimits(shown) ? null : parseTopLevel(shown, ctx);
			}
		}
		const reuse = !this.#noReuse;
		if (!nodes) {
			this.#tree = [...this.#stable, plainOf(tail)];
		} else {
			const keep = reuse ? stableCount(shown, nodes) : 0;
			if (keep > 0) {
				const cut = shown.lastIndexOf('\n', nodes[keep].start - 1) + 1;
				if (shown.slice(0, cut) === tail.slice(0, cut)) {
					for (const node of nodes.slice(0, keep)) this.#stable.push(...node.blocks);
					this.#source += tail.slice(0, cut);
					nodes = nodes.slice(keep);
				}
			}
			this.#tree = this.#stable.concat(nodes.flatMap((n) => n.blocks));
		}
		this.lastMs = performance.now() - t0;
		this.nextAt = t0 + this.lastMs * (1 + STREAM_BACKOFF);
		if (this.lastMs > STREAM_PARSE_BUDGET_MS) this.#overBudget = true;
		return this.#tree;
	}

	/** Reports what the last update cost once rendered (parse, DOM and layout up to the next frame),
	 *  so a tail that is cheap to parse but slow to draw backs off and falls back too. */
	rendered(ms: number, now = performance.now()) {
		if (this.#final) return;
		this.nextAt = Math.max(this.nextAt, now + ms * STREAM_BACKOFF);
		this.#slowFrames = ms > STREAM_FRAME_BUDGET_MS ? this.#slowFrames + 1 : 0;
		if (ms > STREAM_PARSE_BUDGET_MS || this.#slowFrames >= SLOW_FRAMES_MAX) this.#overBudget = true;
	}

	/** The finished render: exactly `parseMarkdown(text)`, reusing every block the stream already
	 *  rendered with the same content, so those keep their DOM. */
	finish(text: string, ctx: RenderContext, key = ''): MdBlockNode[] {
		if (this.#final && this.#text === text && this.#key === key) return this.#tree;
		const previous = key === this.#key ? this.#tree : [];
		if (key !== this.#key) this.#reset(key);
		const full = parseMarkdown(text, ctx);
		this.#tree = full.map((node, i) =>
			previous[i] && sameBlock(previous[i], node) ? previous[i] : node
		);
		this.#text = text;
		this.#final = true;
		this.#overBudget = false;
		return this.#tree;
	}
}

/** How many leading nodes can no longer change as text is appended: those followed by a blank line
 *  with at least two nodes after them. The same rule as streamdown's `countStableBlocks`. */
export function stableCount(text: string, nodes: readonly TopLevelBlock[]): number {
	for (let i = nodes.length - 3; i >= 0; i--) {
		if (blankLineIn(text, nodes[i].end, nodes[i + 1].start)) return i + 1;
	}
	return 0;
}

function blankLineIn(text: string, from: number, to: number): boolean {
	let lineBreak = false;
	for (let i = from; i < to; i++) {
		const c = text.charCodeAt(i);
		if (c === 10) {
			if (lineBreak) return true;
			lineBreak = true;
		} else if (c !== 32 && c !== 9 && c !== 13) lineBreak = false;
	}
	return false;
}

/** The node the streaming caret follows: the last paragraph, heading, code or table cell. */
export type CaretHost = MdBlockNode | MdInlineNode[];

export function caretHost(tree: readonly MdBlockNode[]): CaretHost | null {
	let node = tree.at(-1);
	while (node) {
		switch (node.kind) {
			case 'paragraph':
			case 'heading':
			case 'code':
			case 'plain':
				return node;
			case 'quote':
				node = node.children.at(-1);
				break;
			case 'list':
				node = node.items.at(-1)?.children.at(-1);
				break;
			case 'table':
				return node.rows.at(-1)?.at(-1) ?? node.head.at(-1) ?? null;
			default:
				return null;
		}
	}
	return null;
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isWord = (c: number) =>
	(c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;

/** Index just past the last blank line, or 0. */
function lastBlankLineEnd(text: string): number {
	let lineEnd = -1;
	for (let i = text.length - 1; i >= 0; i--) {
		const c = text.charCodeAt(i);
		if (c === 10) {
			if (lineEnd >= 0) return lineEnd + 1;
			lineEnd = i;
		} else if (c !== 32 && c !== 9 && c !== 13) lineEnd = -1;
	}
	return 0;
}

/** What a still-growing reply shows: unfinished syntax at its end is completed or held back, so it
 *  never flashes raw and then snaps, and a half-typed URL never becomes a link. Display only. */
export function streamingView(text: string): string {
	const fence = openFence(text);
	if (fence) {
		// A closing fence being typed would otherwise show up as code for a frame.
		const nl = text.lastIndexOf('\n');
		const last = text.slice(nl + 1).trim();
		return last && [...last].every((c) => c === fence) ? text.slice(0, nl + 1) : text;
	}
	const start = lastBlankLineEnd(text);
	if (DEFINITION_START_RE.test(text.slice(start, start + 1000))) return text.slice(0, start);
	let seg = holdBackLines(text.slice(start));
	seg = completeLinks(seg);
	// Holding back the last word can reopen a label it closed, so links are checked again after.
	seg = completeLinks(holdBackUrl(seg));
	seg = completeInline(seg);
	return text.slice(0, start) + seg;
}

/** The fence character when `text` ends inside an open fenced code block. Fences nested in quotes
 *  or list items count too; being approximate only costs display. */
export function openFence(text: string): string | null {
	let open: { ch: number; len: number } | null = null;
	let i = 0;
	while (i < text.length) {
		let nl = text.indexOf('\n', i);
		if (nl < 0) nl = text.length;
		let j = i;
		for (;;) {
			const c = text.charCodeAt(j);
			if (j < nl && (c === 32 || c === 9 || c === 62)) j++;
			else break;
		}
		const m = text.charCodeAt(j);
		if ((m === 45 || m === 42 || m === 43) && text.charCodeAt(j + 1) === 32) j += 2;
		else if (m >= 48 && m <= 57) {
			let k = j;
			while (k < nl && k - j < 9 && text.charCodeAt(k) >= 48 && text.charCodeAt(k) <= 57) k++;
			const d = text.charCodeAt(k);
			if ((d === 46 || d === 41) && text.charCodeAt(k + 1) === 32) j = k + 2;
		}
		while (j < nl && text.charCodeAt(j) === 32) j++;
		const c = text.charCodeAt(j);
		if (c === 96 || c === 126) {
			let k = j;
			while (k < nl && text.charCodeAt(k) === c) k++;
			const run = k - j;
			if (run >= 3) {
				if (!open) {
					let tickInInfo = false;
					if (c === 96) for (let t = k; t < nl && !tickInInfo; t++) tickInInfo = text[t] === '`';
					if (!tickInInfo) open = { ch: c, len: run };
				} else if (c === open.ch && run >= open.len && !text.slice(k, nl).trim()) {
					open = null;
				}
			}
		}
		i = nl + 1;
	}
	return open ? String.fromCharCode(open.ch) : null;
}

const MARKERS = new Set(' \t-+*=_#>~`|:.)[]0123456789');
const pipeRow = (line: string) => line.trimStart().startsWith('|');

/** Drops a last line that is only markers (`-`, `1.`, `#`, `>`, a fence or table rule being typed),
 *  which would otherwise flash as an empty list, heading or setext underline, and a table header
 *  row until its delimiter row is complete. */
function holdBackLines(seg: string): string {
	const nl = seg.lastIndexOf('\n');
	const last = seg.slice(nl + 1);
	if (last && [...last].every((c) => MARKERS.has(c))) seg = seg.slice(0, nl + 1);
	const body = seg.endsWith('\n') ? seg.slice(0, -1) : seg;
	const at = body.lastIndexOf('\n') + 1;
	if (!pipeRow(body.slice(at))) return seg;
	const above = at > 0 ? body.slice(body.lastIndexOf('\n', at - 2) + 1, at - 1) : null;
	return above !== null && pipeRow(above) ? seg : seg.slice(0, at);
}

const URLISH_RE = /https?:\/\/|www\.|mailto:|@/i;
const URLISH_GLOBAL_RE = /https?:\/\/|www\.|mailto:|@/gi;

/** Shows an unfinished link as its text and drops an unfinished image. Never adds `]` or `)`, so
 *  nothing becomes a link before its destination is complete. */
function completeLinks(s: string): string {
	const opens: number[] = [];
	const drop = new Set<number>();
	let cutAt = s.length;
	let lastClose: { open: number; close: number } | null = null;
	let code = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		// Code spans have no escapes, so a backslash there must not hide the closing backtick.
		if (c === 92 /* \ */ && !code) {
			i++;
			continue;
		}
		if (c === 96) {
			let k = i;
			while (s.charCodeAt(k) === 96) k++;
			if (!code) code = k - i;
			else if (code === k - i) code = 0;
			i = k - 1;
			continue;
		}
		if (code) continue;
		if (c === 91 /* [ */) opens.push(i);
		else if (c === 93 /* ] */ && opens.length) {
			const open = opens.pop()!;
			lastClose = { open, close: i };
			if (s.charCodeAt(i + 1) !== 40 /* ( */) continue;
			let depth = 1;
			let k = i + 2;
			for (; k < s.length && depth > 0; k++) {
				const d = s.charCodeAt(k);
				if (d === 92) k++;
				else if (d === 40) depth++;
				else if (d === 41) depth--;
			}
			if (depth > 0) {
				// A URL in the label would autolink on its own once the brackets are gone.
				if (s.charCodeAt(open - 1) === 33 /* ! */) cutAt = open - 1;
				else if (URLISH_RE.test(s.slice(open + 1, i))) cutAt = open;
				else {
					drop.add(open);
					cutAt = i;
				}
				lastClose = null;
				break;
			}
			lastClose = null;
			i = k - 1;
		}
	}
	// An unclosed label with a URL after it would show that URL as a link the final may not have.
	let lastUrl = -1;
	for (const m of s.slice(0, cutAt).matchAll(URLISH_GLOBAL_RE)) lastUrl = m.index;
	const labelled = opens.find((open) => open < lastUrl);
	if (labelled !== undefined) cutAt = s.charCodeAt(labelled - 1) === 33 ? labelled - 1 : labelled;
	for (const open of opens) {
		if (open >= cutAt) continue;
		drop.add(open);
		if (s.charCodeAt(open - 1) === 33) drop.add(open - 1);
	}
	// `[text]` at the very end is most likely a link about to get its `(`.
	if (lastClose && lastClose.close === s.length - 1 && lastClose.close - lastClose.open > 2) {
		if (s.charCodeAt(lastClose.open - 1) === 33) cutAt = lastClose.open - 1;
		else if (URLISH_RE.test(s.slice(lastClose.open + 1, lastClose.close))) cutAt = lastClose.open;
		else {
			drop.add(lastClose.open);
			cutAt = lastClose.close;
		}
	}
	if (!drop.size) return s.slice(0, cutAt);
	let out = '';
	let from = 0;
	for (const i of [...drop].sort((a, b) => a - b)) {
		if (i >= cutAt) break;
		out += s.slice(from, i);
		from = i + 1;
	}
	return out + s.slice(from, cutAt);
}

/** GFM links bare URLs and emails as they are typed, so the last word waits for its end. */
function holdBackUrl(s: string): string {
	let i = s.length;
	while (i > 0 && !isSpace(s.charCodeAt(i - 1))) i--;
	const word = s.slice(i);
	return word && (word.startsWith('<') || URLISH_RE.test(word)) ? s.slice(0, i) : s;
}

/** Closes an unclosed code span and unclosed emphasis (`*`, `**`, `_`, `__`, `~~`) at the end, and
 *  drops an opener with nothing after it yet. */
function completeInline(s: string): string {
	const stack: { tok: string; at: number }[] = [];
	let code = 0;
	let codeAt = -1;
	let cut = s.length;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 92 && !code) {
			i++;
			continue;
		}
		if (c === 96) {
			let k = i;
			while (s.charCodeAt(k) === 96) k++;
			if (!code) {
				code = k - i;
				codeAt = i;
			} else if (code === k - i) code = 0;
			i = k - 1;
			continue;
		}
		if (code || (c !== 42 && c !== 95 && c !== 126)) continue;
		let k = i;
		while (s.charCodeAt(k) === c) k++;
		const run = k - i;
		const prev = s.charCodeAt(i - 1);
		const next = s.charCodeAt(k);
		const ch = s[i];
		i = k - 1;
		if (c === 126 && run !== 2) continue;
		if (c === 95 && isWord(prev) && isWord(next)) continue;
		const toks = c === 126 ? ['~~'] : run === 1 ? [ch] : run === 2 ? [ch + ch] : [ch + ch, ch];
		const canOpen = !Number.isNaN(next) && !isSpace(next);
		const canClose = !Number.isNaN(prev) && !isSpace(prev);
		let closed = false;
		if (canClose) {
			for (const tok of [...toks].reverse()) {
				if (stack.at(-1)?.tok === tok) {
					stack.pop();
					closed = true;
				}
			}
		}
		if (closed) continue;
		if (canOpen) for (const tok of toks) stack.push({ tok, at: k - run });
		else if (k === s.length) cut = k - run;
	}
	if (stack.length > CLOSERS_MAX) return s.slice(0, cut);
	let end = cut;
	const contentBefore = (limit: number) => {
		while (end > 0 && isSpace(s.charCodeAt(end - 1))) end--;
		return end > limit;
	};
	let closers = '';
	if (code) {
		if (codeAt < end && contentBefore(codeAt + code)) closers += '`'.repeat(code);
		else end = Math.min(end, codeAt);
	}
	const kept: string[] = [];
	for (let n = stack.length - 1; n >= 0; n--) {
		const { tok, at } = stack[n];
		if (at >= end) continue;
		if (contentBefore(at + tok.length)) kept.push(tok);
		else end = at;
	}
	return s.slice(0, end) + closers + kept.join('');
}
