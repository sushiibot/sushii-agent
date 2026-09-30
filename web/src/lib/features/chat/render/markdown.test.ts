/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	CONTAINER_DEPTH_MAX,
	EMPHASIS_DELIMITER_MAX,
	MARKDOWN_PARSE_MAX,
	MAX_DEPTH,
	containerDepthExceeds,
	emphasisDelimiters,
	fromLegacyBlocks,
	parseMarkdown,
	safeHref,
	type MdBlockNode,
	type MdInlineNode
} from './markdown';

const ORIGIN = 'https://agent.sushii.bot';
const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const OTHER_ID = 'ZyXwVuTsRqPoNmLkJiHgFe';

type Node = MdBlockNode | MdInlineNode;
function walk(nodes: readonly Node[], out: Node[] = []): Node[] {
	for (const n of nodes) {
		out.push(n);
		if ('children' in n) walk(n.children, out);
		if (n.kind === 'list') for (const item of n.items) walk(item.children, out);
		if (n.kind === 'table')
			for (const row of [n.head, ...n.rows]) for (const c of row) walk(c, out);
	}
	return out;
}
const kinds = (text: string, ctx = {}) => walk(parseMarkdown(text, ctx)).map((n) => n.kind);
const links = (text: string, ctx = {}) =>
	walk(parseMarkdown(text, { origin: ORIGIN, ...ctx })).flatMap((n) =>
		n.kind === 'link' ? [n.href] : []
	);
const images = (text: string, imageIds: string[] = []) =>
	walk(parseMarkdown(text, { origin: ORIGIN, imageIds })).flatMap((n) =>
		n.kind === 'image' ? [n.src] : []
	);
const textOf = (text: string) =>
	walk(parseMarkdown(text))
		.flatMap((n) => ('text' in n ? [n.text] : []))
		.join('');

describe('links', () => {
	test.each([
		['https://example.com/a?b=c', 'https://example.com/a?b=c'],
		['http://example.com', 'http://example.com/'],
		['mailto:me@example.com', 'mailto:me@example.com']
	])('%s is a link', (url, href) => {
		expect(links(`[x](${url})`)).toEqual([href]);
	});

	test.each([
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		'java\tscript:alert(1)',
		'&#106;avascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'vbscript:msgbox(1)',
		'file:///etc/passwd',
		'blob:https://agent.sushii.bot/x',
		'/api/chat/stop',
		'/f/' + ID,
		'//evil.example/x',
		'./relative',
		'#frag',
		'https://agent.sushii.bot/api/chat/approvals/n',
		'https://agent.sushii.bot/f/' + ID,
		'https://agent.sushii.bot./api/me',
		'http://agent.sushii.bot/api/me',
		'https://AGENT.sushii.bot:8443/api/me'
	])('%s renders as text', (url) => {
		expect(links(`[click](<${url}>)`)).toEqual([]);
		expect(textOf(`[click](<${url}>)`)).toContain('click');
	});

	test('reference links go through the same check', () => {
		expect(links('[a][x]\n\n[x]: javascript:alert(1)')).toEqual([]);
		expect(links('[a][x]\n\n[x]: https://ok.example')).toEqual(['https://ok.example/']);
	});

	test('autolinks and GFM literals are checked too', () => {
		expect(links('<javascript:alert(1)>')).toEqual([]);
		expect(links('see www.example.com and https://a.example')).toEqual([
			'http://www.example.com/',
			'https://a.example/'
		]);
	});

	test('href is the parsed serialization, not the source', () => {
		expect(links('[x](HTTPS://EXAMPLE.com/%7e)')).toEqual(['https://example.com/%7e']);
	});

	test('safeHref allows mailto even when an origin is given', () => {
		expect(safeHref('mailto:a@b.c', ORIGIN)).toBe('mailto:a@b.c');
	});

	test('no link nests inside another', () => {
		for (const md of [
			'[a [b](https://b.example)](https://a.example)',
			'[see https://b.example here](https://a.example)',
			'[![x](https://b.example/i.png)](https://a.example)'
		]) {
			for (const link of walk(parseMarkdown(md)).filter((n) => n.kind === 'link')) {
				expect(walk(link.children).some((n) => n.kind === 'link')).toBe(false);
			}
		}
	});
});

describe('images', () => {
	test('only a /f/<id> the bot attached inline renders as an image', () => {
		expect(images(`![cat](/f/${ID})`, [ID])).toEqual([`/f/${ID}`]);
	});

	test.each([
		[`![x](/f/${OTHER_ID})`, [ID]],
		[`![x](/f/${ID})`, []],
		[`![x](/f/${ID}?a=1)`, [ID]],
		[`![x](/f/${ID}/../../api)`, [ID]],
		[`![x](https://agent.sushii.bot/f/${ID})`, [ID]],
		['![x](https://tracker.example/pixel.png)', [ID]],
		['![x](javascript:alert(1))', [ID]],
		['![x](data:image/svg+xml,<svg onload=alert(1)>)', [ID]]
	])('%s is not an image', (md, ids) => {
		expect(images(md, ids)).toEqual([]);
	});

	test('an off-site image becomes a link, an unsafe one plain text', () => {
		expect(links('![pic](https://tracker.example/p.png)')).toEqual([
			'https://tracker.example/p.png'
		]);
		expect(links('![pic](javascript:alert(1))')).toEqual([]);
		expect(textOf('![pic](javascript:alert(1))')).toBe('pic');
	});
});

describe('raw HTML and spoofing', () => {
	test.each([
		'<script>alert(1)</script>',
		'<img src=x onerror=alert(1)>',
		'<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
		'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
		'<a href="javascript:alert(1)">x</a>',
		'<button>Approve</button>',
		'<form action="/api/chat/approvals/abc"><button>Approve</button></form>',
		'text <b onmouseover=alert(1)>inline</b> text'
	])('%s stays literal text', (payload) => {
		const tree = walk(parseMarkdown(payload, { origin: ORIGIN }));
		expect(tree.some((n) => n.kind === 'link' || n.kind === 'image')).toBe(false);
		expect(textOf(payload)).toContain('<');
	});

	test('a markdown approval spoof has no controls, only text, emphasis and a heading', () => {
		const spoof = [
			'## 🛡 sushii-agent needs your approval to run `send_email`',
			'',
			'**[Approve](https://agent.sushii.bot/api/chat/approvals/abc)**  [Deny](/api/chat/approvals/abc)',
			'',
			'<div class="bg-approval-surface"><button data-surface="approval">Approve</button></div>'
		].join('\n');
		const found = new Set(kinds(spoof, { origin: ORIGIN }));
		expect(
			[...found].every((k) => ['heading', 'paragraph', 'text', 'code', 'strong'].includes(k))
		).toBe(true);
	});

	test('tool output and filenames with markup parse as text in code', () => {
		const tree = parseMarkdown(
			'```\n<script>alert(1)</script>\n```\n\n`<img src=x onerror=alert(1)>`'
		);
		expect(tree[0]).toEqual({ kind: 'code', lang: null, text: '<script>alert(1)</script>' });
		expect(walk(tree).some((n) => n.kind === 'image' || n.kind === 'link')).toBe(false);
	});

	test('entities decode to text without a DOM', () => {
		expect(textOf('&lt;script&gt; &amp; &copy;')).toBe('<script> & ©');
	});
});

describe('structure', () => {
	test('GFM tables, lists, task items and strikethrough', () => {
		const tree = parseMarkdown(
			'| a | b |\n|:-|-:|\n| 1 | 2 |\n\n- [x] done\n- todo\n\n3. c\n\n~~gone~~'
		);
		expect(tree.map((b) => b.kind)).toEqual(['table', 'list', 'list', 'paragraph']);
		const table = tree[0] as Extract<MdBlockNode, { kind: 'table' }>;
		expect(table.align).toEqual(['left', 'right']);
		expect(table.rows.length).toBe(1);
		const tasks = tree[1] as Extract<MdBlockNode, { kind: 'list' }>;
		expect(tasks.items.map((i) => i.checked)).toEqual([true, null]);
		expect((tree[2] as Extract<MdBlockNode, { kind: 'list' }>).start).toBe(3);
		expect(kinds('~~gone~~')).toContain('del');
	});

	test('deep nesting flattens to text past MAX_DEPTH', () => {
		const depth = (nodes: readonly MdBlockNode[]): number =>
			Math.max(0, ...nodes.map((n) => (n.kind === 'quote' ? 1 + depth(n.children) : 0)));
		const deep = '>'.repeat(CONTAINER_DEPTH_MAX) + ' deep';
		const tree = parseMarkdown(deep);
		expect(depth(tree)).toBeGreaterThan(1);
		expect(depth(tree)).toBeLessThanOrEqual(MAX_DEPTH + 1);
		expect(textOf(deep)).toContain('deep');
	});

	// These overflow V8's stack inside fromMarkdown; e2e/render-harness.test.ts runs them in Chromium.
	test.each([
		['>'.repeat(16_000)],
		['> '.repeat(8_000)],
		['1. '.repeat(5_333)],
		['> - '.repeat(4_000)],
		['- > 1. '.repeat(2_285)],
		['- '.repeat(8_000)]
	])('container nesting past the limit renders unparsed (%#)', (text) => {
		expect(parseMarkdown(text)).toEqual([{ kind: 'plain', text }]);
	});

	test('the depth scan counts markers per line, not across lines', () => {
		expect(containerDepthExceeds('> '.repeat(CONTAINER_DEPTH_MAX))).toBe(false);
		expect(containerDepthExceeds('> '.repeat(CONTAINER_DEPTH_MAX + 1))).toBe(true);
		expect(containerDepthExceeds('- a\n'.repeat(5_000))).toBe(false);
		expect(containerDepthExceeds('12345678901. '.repeat(40))).toBe(false);
		expect(containerDepthExceeds('---\n***\n+++\n' + 'x > y > z '.repeat(100))).toBe(false);
		expect(containerDepthExceeds('text\n' + '1) '.repeat(40))).toBe(true);
	});

	test('delimiter-heavy text renders unparsed; code identifiers do not count', () => {
		const run = '*'.repeat(7_999) + 'a' + '*'.repeat(7_999);
		expect(parseMarkdown(run)).toEqual([{ kind: 'plain', text: run }]);
		expect(parseMarkdown('_'.repeat(8_000))).toEqual([{ kind: 'plain', text: '_'.repeat(8_000) }]);
		expect(emphasisDelimiters('snake_case_name __init__ *a*')).toBe(6);
		const code = 'x_y = a_b.c_d\n'.repeat(1_000);
		expect(emphasisDelimiters(code)).toBe(0);
		expect(parseMarkdown('**ok**' + ' a'.repeat(EMPHASIS_DELIMITER_MAX))[0].kind).toBe('paragraph');
	});

	test('a failure inside the parser or renderer falls back to plain text', () => {
		const imageIds = {
			[Symbol.iterator]() {
				throw new RangeError('Maximum call stack size exceeded');
			}
		};
		expect(parseMarkdown('**x**', { imageIds })).toEqual([{ kind: 'plain', text: '**x**' }]);
	});

	test('text over the parse cap renders unparsed', () => {
		const long = '*'.repeat(MARKDOWN_PARSE_MAX + 1);
		expect(parseMarkdown(long)).toEqual([{ kind: 'plain', text: long }]);
	});

	test('legacy blocks keep the link rule', () => {
		const tree = fromLegacyBlocks(
			[
				{
					kind: 'p',
					inlines: [
						{ kind: 'link', text: 'bad', href: 'javascript:alert(1)' },
						{ kind: 'link', text: 'good', href: 'https://ok.example' }
					]
				}
			],
			{ origin: ORIGIN }
		);
		expect(walk(tree).flatMap((n) => (n.kind === 'link' ? [n.href] : []))).toEqual([
			'https://ok.example/'
		]);
	});
});
