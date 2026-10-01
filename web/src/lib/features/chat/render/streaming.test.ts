import { describe, expect, test } from 'bun:test';
import { parseMarkdown, type MdBlockNode, type MdInlineNode } from './markdown';
import { caretHost, MarkdownStream, openFence, streamingView } from './streaming';

const CTX = { origin: 'https://agent.sushii.bot', imageIds: ['AAAAAAAAAAAAAAAAAAAAAA'] };

const CORPUS: Record<string, string> = {
	'loose list with continuation': '- a\n\n- b\n\n  continued\n\n- c\n\npara after\n\n- new list\n',
	'ordered lists split by a blank line':
		'1. one\n\n2. two\n\n3. three\n\nafter\n\n10) x\n\n2\n\n3.',
	'fences with blank lines':
		'```js\nconst a = 1;\n\nconst b = 2;\n```\n\ntext\n\n~~~\nx\n\n~~~\n\n````\n```\nin\n````\n\nend',
	'indented code': 'para\n\n    code\n\n    more code\n\nafter\n\nlast',
	'html comment across blank lines': 'a\n\n<!--\n\nhidden **x**\n\n-->\n\nb\n\nc\n\nd',
	tables: '| a | b |\n|---|:-:|\n| 1 | **2** |\n\nnext\n\n| c |\n| - |\n| 3 |\n\nend',
	'quotes with blank lines': '> a\n>\n> b\n\n> c\n\nd\n\n> - e\n>\n>   f\n\ng',
	'setext headings': 'Title\n=====\n\nSub\n---\n\npara\nline\n\nx\n\n***\n\ny',
	definitions:
		'See [the docs][d] and a note[^1].\n\nmore\n\n[d]: https://example.com\n\n[^1]: note\n\ntail',
	'a typical reply':
		'## Plan\n\nI checked **three** things and _one_ `flag`:\n\n1. The [docs](https://example.com/a_(b)).\n2. Run:\n\n   ```sh\n   bun test\n   ```\n\n3. ~~Old~~ new.\n\n> Note: see https://example.com/x and mail a@b.co.\n\n![shot](/f/AAAAAAAAAAAAAAAAAAAAAA)\n\nDone.'
};

const identity = (t: string) => t;

function* prefixes(text: string, step = 1) {
	for (let n = 0; n <= text.length; n += step) yield text.slice(0, n);
	yield text;
}

const json = (v: unknown) => JSON.stringify(v);

function hrefs(
	nodes: readonly (MdBlockNode | MdInlineNode)[],
	out = new Set<string>()
): Set<string> {
	for (const node of nodes) {
		if (node.kind === 'link') out.add(node.href);
		if (node.kind === 'image') out.add(node.src);
		if ('children' in node) hrefs(node.children as (MdBlockNode | MdInlineNode)[], out);
		if (node.kind === 'list') for (const item of node.items) hrefs(item.children, out);
		if (node.kind === 'table')
			for (const cell of [...node.head, ...node.rows.flat()]) hrefs(cell, out);
	}
	return out;
}

describe('incremental parse', () => {
	for (const [name, doc] of Object.entries(CORPUS)) {
		test(`${name}: kept blocks plus the tail equal a full parse at every prefix`, () => {
			const stream = new MarkdownStream(identity);
			for (const prefix of prefixes(doc)) {
				expect(json(stream.update(prefix, CTX))).toBe(json(parseMarkdown(prefix, CTX)));
			}
		});

		test(`${name}: with display edits, kept blocks still match the finished reply`, () => {
			const stream = new MarkdownStream();
			const full = parseMarkdown(doc, CTX);
			let kept: MdBlockNode[] = [];
			for (const prefix of prefixes(doc)) {
				const tree = stream.update(prefix, CTX);
				kept = tree.slice(0, stream.kept);
				// A definition arriving later legitimately changes earlier references.
				if (name !== 'definitions') expect(json(kept)).toBe(json(full.slice(0, kept.length)));
			}
			const done = stream.finish(doc, CTX);
			expect(json(done)).toBe(json(full));
			kept.forEach((block, i) => expect(done[i]).toBe(block));
		});
	}

	test('long replies keep most blocks and parse only the tail', () => {
		const doc = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with **bold**.`).join('\n\n');
		const stream = new MarkdownStream();
		let tree: MdBlockNode[] = [];
		for (const prefix of prefixes(doc, 7)) tree = stream.update(prefix, CTX);
		expect(stream.kept).toBeGreaterThanOrEqual(38);
		const first = tree[0];
		expect(stream.update(doc + '\n\nmore', CTX)[0]).toBe(first);
		expect(stream.finish(doc + '\n\nmore', CTX)[0]).toBe(first);
	});

	test('the same input returns the same array', () => {
		const stream = new MarkdownStream();
		const a = stream.update('**a** b\n\nc', CTX);
		expect(stream.update('**a** b\n\nc', CTX)).toBe(a);
		const done = stream.finish('**a** b\n\nc', CTX);
		expect(stream.finish('**a** b\n\nc', CTX)).toBe(done);
	});

	test('a definition anywhere turns reuse off, so earlier references resolve', () => {
		const stream = new MarkdownStream(identity);
		const doc = CORPUS.definitions;
		for (const prefix of prefixes(doc)) stream.update(prefix, CTX);
		expect(stream.kept).toBe(0);
		expect(hrefs(stream.update(doc, CTX)).has('https://example.com/')).toBe(true);
	});

	test('replaced text and new inline images start over', () => {
		const stream = new MarkdownStream(identity);
		stream.update('a\n\nb\n\nc\n\nd', CTX);
		expect(stream.kept).toBeGreaterThan(0);
		expect(json(stream.update('x\n\ny', CTX))).toBe(json(parseMarkdown('x\n\ny', CTX)));
		const img = 'a\n\nb\n\nc\n\n![p](/f/BBBBBBBBBBBBBBBBBBBBBB)';
		const ctx2 = { ...CTX, imageIds: ['BBBBBBBBBBBBBBBBBBBBBB'] };
		stream.update(img, CTX, 'one');
		expect(json(stream.update(img, ctx2, 'two'))).toBe(json(parseMarkdown(img, ctx2)));
	});

	test('input past the parse limits renders as one plain block, as the full parse does', () => {
		const stream = new MarkdownStream();
		const hostile = '> '.repeat(40) + 'x';
		expect(stream.update(hostile, CTX)).toEqual([{ kind: 'plain', text: hostile }]);
		expect(stream.finish(hostile, CTX)).toEqual(parseMarkdown(hostile, CTX));
	});
});

// Payloads from the adversarial review of streaming: a URL inside an unclosed label, a backslash in
// a code span, and definitions that shadow each other from quotes, lists and multi-line labels.
const REVIEWED_LINKS = [
	'Read [the docs at https://evil.example/login first](https://good.example) ok\n',
	'[see https://evil.com/a now](https://good.com) end\n',
	'[visit www.evil.com today](https://good.com) end\n',
	'[mail bob@evil.com x](https://good.com) end\n',
	'[good\nref]: https://good.com\n\npara one\n\npara two\n\n[good ref]: https://evil.com\n\n[click here][good ref] and more text\n\nmore\n',
	'> [r]: https://good.com\n\npara one\n\npara two\n\n> [r]: https://evil.com\n\n[click][r] tail\n\nmore\n',
	'- [r]: https://good.com\n\npara one\n\npara two\n\n- [r]: https://evil.com\n\n[click][r] tail\n\nmore\n',
	'[t](<https://evil.com/a b>) x\n',
	'`a\\` [t](https://evil.com/partial "ti tle") x\n',
	'[t](https://good.com/x "https://evil.com/y z") x\n',
	'[a][b] x\n\n[b]: https://good.com/long/path\n',
	'![alt https://evil.com/q z](https://good.com/i.png) x\n',
	'[a [b](https://evil.com/x) c](https://good.com) x\n',
	'x <https://evil.com/a> y\n',
	'| a | b |\n|---|---|\n| [t](https://good.com) | https://evil.com/x y |\n',
	'**bold https://evil.com/a** x\n',
	'x `https://evil.com/abc def` y\n',
	'[r]: https://good.com\n\n[see https://evil.com/x][r] end\n',
	'[see https://evil.com/x]: https://good.com\n\n[see https://evil.com/x][] end\n',
	'[see https://evil.com/x][r] end\n\n[r]: https://good.com\n',
	'[go WWW.EVIL.COM now](https://good.com) x\n',
	'[x xmpp:a@evil.com y](https://good.com) z\n',
	'[x <https://evil.com/a> y](https://good.com) z\n',
	'[see ![x](https://evil.com/a.png) now](https://good.com) z\n',
	'*[see https://evil.com/x now*](https://good.com) z\n',
	'[see\nhttps://evil.com/x\nnow](https://good.com) z\n',
	'`[` [see https://evil.com/x now](https://good.com) z\n',
	'[a `b` https://evil.com/x c](https://good.com) z\n',
	'\\[ [see https://evil.com/x now](https://good.com) z\n',
	'| a |\n|---|\n| [see https://evil.com/x now](https://good.com) |\n',
	'- [see https://evil.com/x now](https://good.com)\n',
	'> [see https://evil.com/x now](https://good.com)\n',
	'# [see https://evil.com/x now](https://good.com)\n'
];

function texts(nodes: readonly (MdBlockNode | MdInlineNode)[], out: string[] = []): string[] {
	for (const node of nodes) {
		if ('text' in node) out.push(node.text);
		if ('children' in node) texts(node.children as (MdBlockNode | MdInlineNode)[], out);
		if (node.kind === 'list') for (const item of node.items) texts(item.children, out);
		if (node.kind === 'table')
			for (const cell of [...node.head, ...node.rows.flat()]) texts(cell, out);
	}
	return out;
}

// A definition still being typed, in every place the review found one can start.
const T =
	'https://example.com "Heads up: the next approval only reads ~/notes.txt.\nIt is safe to tap Approve.';
const VANISHING: [string, string, string][] = [
	['top', 'Checking.\n\n[x]: ' + T, '"\n\nDone.'],
	['next line', 'Checking.\n\n[Note: tap Approve]:\n', '/x\n\nDone.'],
	['after heading', 'Checking.\n\n# Status\n[x]: ' + T, '"\n\nDone.'],
	['after rule', 'Checking.\n\n***\n[x]: ' + T, '"\n\nDone.'],
	['after fence', 'Checking.\n\n```\nls\n```\n[x]: ' + T, '"\n\nDone.'],
	['in quote', 'Checking.\n\n> [x]: ' + T.replace('\n', '\n> '), '"\n\nDone.'],
	['in list', 'Checking.\n\n- [x]: ' + T.replace('\n', '\n  '), '"\n\nDone.'],
	['after definition', 'Checking.\n\n[a]: https://a.com\n[x]: ' + T, '"\n\nDone.'],
	['no blank line before', '[x]: ' + T, '"\n\nDone.'],
	['after table', 'Checking.\n\n| a |\n|---|\n| b |\n[x]: ' + T, '"\n\nDone.'],
	['after html', 'Checking.\n\n<div>\n</div>\n[x]: ' + T, '"\n\nDone.'],
	['after setext', 'Checking.\n\nTitle\n===\n[x]: ' + T, '"\n\nDone.'],
	['footnote', 'Checking.\n\n[^1]: Heads up, tap Approve', '\n\nDone.']
];

describe('display edits', () => {
	const cases: [string, string][] = [
		['**bol', '**bol**'],
		['hello **', 'hello '],
		['a *it', 'a *it*'],
		['a _it', 'a _it_'],
		['**a _b', '**a _b_**'],
		['***bi', '***bi***'],
		['~~del', '~~del~~'],
		['`code', '`code`'],
		['x `', 'x '],
		['snake_case and 2 * 3 = 6 ok', 'snake_case and 2 * 3 = 6 ok'],
		['[link](https://exa', 'link'],
		['see [docs', 'see docs'],
		['[text]', 'text'],
		['![a](/f/AAAA', ''],
		['go https://exa', 'go '],
		['go www.exa', 'go '],
		['mail a@b.c', 'mail '],
		['x <https://a', 'x '],
		['```js\nx\n``', '```js\nx\n'],
		['- a\n-', '- a\n'],
		['Title\n=', 'Title\n'],
		['para\n\n#', 'para\n\n'],
		['| a | b |\n|--', ''],
		['| a | b |\n|---|---|\n| x', '| a | b |\n|---|---|\n| x'],
		['`a` **b `c', '`a` **b `c`**'],
		['`a\\` [t](https://evil.com/partial ', '`a\\` t'],
		['[see https://evil.com/a now', ''],
		['x [see https://evil.com/a now](https://go', 'x '],
		['a\n\n[x]: https://example.com "Heads up: tap **Approve**', 'a\n\n'],
		['a\n\n[label]:\n', 'a\n\n'],
		['*a '.repeat(12), '*a '.repeat(12)]
	];
	for (const [input, shown] of cases) {
		test(JSON.stringify(input), () => expect(streamingView(input)).toBe(shown));
	}

	test('edits only touch text after the last blank line', () => {
		for (const doc of Object.values(CORPUS)) {
			for (const prefix of prefixes(doc)) {
				const cut = prefix.lastIndexOf('\n\n');
				if (cut < 0 || openFence(prefix)) continue;
				expect(streamingView(prefix).slice(0, cut + 2)).toBe(prefix.slice(0, cut + 2));
			}
		}
	});

	test('never adds a ] or ), so nothing turns into a link early', () => {
		const count = (s: string, c: string) => s.split(c).length - 1;
		for (const doc of [...Object.values(CORPUS), '[a](b [c](d) [[e]](f(g)h) ![i](/f/x']) {
			for (const prefix of prefixes(doc)) {
				const shown = streamingView(prefix);
				expect(count(shown, ']')).toBeLessThanOrEqual(count(prefix, ']'));
				expect(count(shown, ')')).toBeLessThanOrEqual(count(prefix, ')'));
			}
		}
	});

	test('every link or image in any frame is one the finished reply has', () => {
		const docs = [
			CORPUS['a typical reply'],
			'Read [the guide](https://example.com/guide?a=1&b=2) then https://example.org/path_x.\n\nOr <https://example.net/z> or www.example.com/w or me@example.com now.',
			'Inline ![img](/f/AAAAAAAAAAAAAAAAAAAAAA) and [nested [x]](https://example.com/n) and [a](https://example.com/p(1)) ok',
			...REVIEWED_LINKS
		];
		for (const doc of docs) {
			const final = hrefs(parseMarkdown(doc, CTX));
			const stream = new MarkdownStream();
			for (const prefix of prefixes(doc)) {
				for (const href of hrefs(stream.update(prefix, CTX))) {
					expect(final.has(href), `${href} at ${JSON.stringify(prefix)}`).toBe(true);
				}
			}
		}
	});

	test('an open fence grows as a code block', () => {
		const stream = new MarkdownStream();
		const tree = stream.update('Intro\n\n```ts\nconst a = 1;\nconst b', CTX);
		expect(tree.at(-1)).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1;\nconst b' });
		expect(openFence('```\na\n```\n')).toBeNull();
		expect(openFence('- ```\n  a')).toBe('`');
	});
});

describe('vanishing definitions', () => {
	for (const [name, prefix, rest] of VANISHING) {
		test(`${name}: no text shows mid-stream that the finished reply drops`, () => {
			const stream = new MarkdownStream();
			const frame = texts(stream.update(prefix, CTX)).join('|');
			const done = texts(stream.finish(prefix + rest, CTX)).join('|');
			expect(frame.includes('Approve') && !done.includes('Approve')).toBe(false);
		});
	}
});

describe('limits', () => {
	test('closers added for display never push a reply past the delimiter cap', () => {
		const text = ' *a*'.repeat(1499) + ' **b';
		const tree = new MarkdownStream().update(text, CTX);
		expect(tree).toEqual([{ kind: 'plain', text }]);
	});

	test('slow rendered frames fall back to plain text; one noisy frame does not', () => {
		const text = 'Some **text**\n\nmore';
		const stream = new MarkdownStream();
		stream.update(text, CTX);
		stream.rendered(40, 0);
		stream.rendered(10, 0);
		stream.rendered(40, 0);
		expect(stream.update(text + ' a', CTX)[0].kind).toBe('paragraph');
		stream.rendered(40, 0);
		stream.rendered(40, 0);
		expect(stream.update(text + ' ab', CTX)).toEqual([{ kind: 'plain', text: text + ' ab' }]);
		const once = new MarkdownStream();
		once.update(text, CTX);
		once.rendered(60, 0);
		expect(once.update(text + ' a', CTX)[0].kind).toBe('plain');
		expect(once.nextAt).toBeGreaterThan(0);
		expect(once.finish(text + ' a', CTX)[0].kind).toBe('paragraph');
	});

	test('the first definition of a label wins', () => {
		const doc =
			'[x] and [y]\n\n[x]: https://a.example\n\n[x]: https://b.example\n\n> [y]: https://c.example\n\n[y]: https://d.example';
		expect([...hrefs(parseMarkdown(doc))]).toEqual(['https://a.example/', 'https://c.example/']);
	});
});

describe('caret', () => {
	test('follows the last paragraph, item, cell or code block', () => {
		const at = (text: string) => caretHost(parseMarkdown(text));
		expect(at('a\n\nb')).toMatchObject({ kind: 'paragraph', children: [{ text: 'b' }] });
		expect(at('- a\n- b')).toMatchObject({ kind: 'paragraph', children: [{ text: 'b' }] });
		expect(at('> x\n> - y')).toMatchObject({ kind: 'paragraph', children: [{ text: 'y' }] });
		expect(at('```\ncode')).toMatchObject({ kind: 'code' });
		expect(at('| a |\n| - |\n| b |')).toEqual([{ kind: 'text', text: 'b' }]);
		expect(at('---')).toBeNull();
		expect(caretHost([])).toBeNull();
	});
});
