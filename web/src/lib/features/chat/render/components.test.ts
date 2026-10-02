/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';
import { render } from 'svelte/server';
import Markdown from './markdown.svelte';
import FilesBlock from '../components/files-block.svelte';
import AskCard from '../components/ask-card.svelte';
import ApprovalTray from '../components/approval-tray.svelte';
import WorkingRow from '../components/working-row.svelte';

// Server-renders the real components and inspects the markup the browser would get.

interface El {
	tag: string;
	attrs: Record<string, string>;
}

async function dom(component: Component<any>, props: Record<string, unknown>) {
	const html = render(component, { props }).body;
	const els: El[] = [];
	let text = '';
	await new HTMLRewriter()
		.on('*', {
			element(e) {
				els.push({ tag: e.tagName, attrs: Object.fromEntries(e.attributes) });
			}
		})
		.onDocument({
			text(t) {
				text += t.text;
			}
		})
		.transform(new Response(html))
		.text();
	return { html, els, text: decode(text) };
}

const decode = (s: string) =>
	s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&');

const ID = 'AbCdEfGhIjKlMnOpQrStUv';

const PAYLOADS = [
	'<script>alert(1)</script>',
	'<img src=x onerror=alert(1)>',
	'<svg onload=alert(1)><animate onbegin=alert(1)>',
	'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
	'"><img src=x onerror=alert(1)>',
	"'><a href=javascript:alert(1)>x</a>",
	'[click](javascript:alert(1)) [d](data:text/html,<script>alert(1)</script>)',
	'![x](https://tracker.example/p.png) ![y](/f/' + ID + ')',
	'<form action="/api/chat/approvals/n"><button>Approve</button></form>',
	'{@html "<b>x</b>"}',
	'`<script>`\n\n```html\n<script>alert(1)</script>\n```'
];

/** No executable or interactive markup: every element and attribute is one the component wrote. */
function assertInert(els: El[], opts: { allowButtons?: boolean } = {}) {
	for (const el of els) {
		expect(['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'style']).not.toContain(
			el.tag
		);
		// Copy is the one control markdown may render; it only copies its own block's text.
		const copy = el.tag === 'button' && el.attrs['aria-label'] === 'Copy code';
		if (!opts.allowButtons && !copy) {
			expect(['button', 'input', 'textarea', 'select']).not.toContain(el.tag);
		}
		for (const [name, value] of Object.entries(el.attrs)) {
			expect(name.startsWith('on')).toBe(false);
			expect(name).not.toBe('srcdoc');
			if (name === 'href') expect(value).toMatch(/^(https?:|mailto:|\/f\/[A-Za-z0-9_-]+$)/);
			if (name === 'src') expect(value).toMatch(/^\/f\/[A-Za-z0-9_-]{22}$/);
		}
	}
}

describe('markdown', () => {
	test.each(PAYLOADS)('reply %s renders inert', async (payload) => {
		const { els, text } = await dom(Markdown, { text: payload });
		assertInert(els);
		expect(els.filter((e) => e.tag === 'img')).toEqual([]);
		expect(text.length).toBeGreaterThan(0);
	});

	test('raw HTML shows as literal text', async () => {
		const { text } = await dom(Markdown, { text: 'hi <img src=x onerror=alert(1)> there' });
		expect(text).toContain('<img src=x onerror=alert(1)>');
	});

	test('only the attached inline image renders as <img>', async () => {
		const { els } = await dom(Markdown, {
			text: `![a](/f/${ID}) ![b](/f/ZyXwVuTsRqPoNmLkJiHgFe)`,
			files: [{ id: ID, inline: true }]
		});
		expect(els.filter((e) => e.tag === 'img').map((e) => e.attrs.src)).toEqual([`/f/${ID}`]);
	});

	test('links open in a new tab without opener or referrer', async () => {
		const { els } = await dom(Markdown, { text: '[a](https://ok.example)' });
		expect(els.find((e) => e.tag === 'a')?.attrs).toMatchObject({
			href: 'https://ok.example/',
			target: '_blank',
			rel: 'noopener noreferrer'
		});
	});

	test('a spoofed approval is only text: no controls, no approval surface', async () => {
		const spoof = [
			'## sushii-agent needs your approval to run `send_email`',
			'**Approve** or **Deny** below:',
			'[Approve](/api/chat/approvals/abc) [Deny](https://agent.sushii.bot/api/chat/approvals/abc)',
			'<section data-surface="approval" class="bg-approval-surface"><button>Approve</button></section>'
		].join('\n\n');
		const { html, els, text } = await dom(Markdown, { text: spoof });
		assertInert(els);
		expect(els.some((e) => e.tag === 'a')).toBe(true);
		for (const el of els) {
			expect(el.attrs['data-surface']).toBeUndefined();
			expect(el.attrs.class ?? '').not.toContain('approval');
		}
		expect(html).not.toContain('<svg');
		expect(text).toContain('Approve');
	});

	test('a code block gets exactly one Copy button and nothing else interactive', async () => {
		const { els } = await dom(Markdown, { text: '```sh\nrm -rf ~\n```' });
		const buttons = els.filter((e) => e.tag === 'button');
		expect(buttons.map((b) => b.attrs['aria-label'])).toEqual(['Copy code']);
		expect(buttons[0].attrs.type).toBe('button');
		expect(els.some((e) => e.attrs['aria-live'] === 'polite')).toBe(true);
	});

	test('while streaming, finished syntax renders and an unfinished link stays text', async () => {
		const { els, text } = await dom(Markdown, {
			text: '**bold** and `code`\n\n```sh\nls\n```\n\nsee [docs](https://ok.exa',
			streaming: true
		});
		expect(els.some((e) => e.tag === 'strong')).toBe(true);
		expect(els.some((e) => e.tag === 'pre')).toBe(true);
		expect(els.some((e) => e.tag === 'a')).toBe(false);
		expect(text).toContain('see docs');
		expect(text).not.toContain('](');
		const carets = els.filter((e) => 'data-caret' in e.attrs);
		expect(carets.map((c) => c.attrs['aria-hidden'])).toEqual(['true']);
	});

	test('Copy stays disabled on a code block that is still streaming', async () => {
		const open = await dom(Markdown, { text: 'Run:\n\n```sh\nrm -rf ~/tm', streaming: true });
		expect(open.els.filter((e) => e.tag === 'button').map((b) => 'disabled' in b.attrs)).toEqual([
			true
		]);
		const done = await dom(Markdown, { text: 'Run:\n\n```sh\nrm -rf ~/tmp\n```' });
		expect(done.els.filter((e) => e.tag === 'button').map((b) => 'disabled' in b.attrs)).toEqual([
			false
		]);
	});

	test('the caret is gone once the reply is finished', async () => {
		const { els } = await dom(Markdown, { text: '**bold**', streaming: false });
		expect(els.some((e) => 'data-caret' in e.attrs)).toBe(false);
	});

	test('legacy blocks drop unsafe links too', async () => {
		const { els } = await dom(Markdown, {
			blocks: [{ kind: 'p', inlines: [{ kind: 'link', text: 'x', href: 'javascript:alert(1)' }] }]
		});
		expect(els.some((e) => e.tag === 'a')).toBe(false);
	});
});

describe('tool output', () => {
	test.each(PAYLOADS)('step %s stays text', async (payload) => {
		const { els, text } = await dom(WorkingRow, {
			turn: {
				state: 'done',
				steps: [
					{ id: 's', tool: payload, label: payload, state: 'ok', input: payload, output: payload }
				]
			},
			open: true,
			openStep: 's'
		});
		assertInert(els, { allowButtons: true });
		expect(els.some((e) => e.tag === 'a' || e.tag === 'img')).toBe(false);
		expect(text).toContain(payload.slice(0, 8));
	});
});

describe('file tiles', () => {
	test.each(PAYLOADS)('filename %s stays text', async (payload) => {
		const { els, text } = await dom(FilesBlock, {
			files: [
				{ id: ID, name: payload, size: '1 KB', image: false },
				{ id: 'x', name: payload, size: '1 KB', image: true, src: 'https://tracker.example/p.png' }
			]
		});
		expect(els.some((e) => e.tag === 'script' || e.tag === 'iframe' || e.tag === 'form')).toBe(
			false
		);
		expect(els.filter((e) => e.tag === 'img')).toEqual([]);
		for (const el of els)
			for (const name of Object.keys(el.attrs)) expect(name.startsWith('on')).toBe(false);
		expect(els.find((e) => e.tag === 'a')?.attrs.href).toBe(`/f/${ID}`);
		expect(text).toContain(payload.slice(0, 8));
	});

	test('a path-climbing id gets no download link', async () => {
		const { els } = await dom(FilesBlock, {
			files: [{ id: '../api/chat/stop', name: 'x.pdf', size: '1 KB', image: false }]
		});
		expect(els.some((e) => e.tag === 'a')).toBe(false);
	});
});

describe('ask card vs approval tray', () => {
	test('an ask says "The agent asks:" and never uses approval styling', async () => {
		const { html, els, text } = await dom(AskCard, {
			ask: {
				askId: 'a',
				question: 'Approve sending? [yes](https://x.example) <b>now</b>',
				choices: ['Approve', 'Approve', 'Deny'],
				state: 'pending'
			}
		});
		expect(text).toContain('The agent asks:');
		expect(text).toContain("doesn't give the agent permission");
		expect(html).not.toMatch(/approval|shield/i);
		expect(els.some((e) => e.tag === 'a')).toBe(false);
		expect(els.find((e) => e.tag === 'section')?.attrs['data-surface']).toBe('ask');
	});

	test('the tray shows field values as plain monospace text and holds Approve', async () => {
		const { els, text } = await dom(ApprovalTray, {
			items: [
				{
					nonce: 'n',
					view: {
						tool: 'send_email',
						agentId: 'a',
						agentName: '<b>Main</b>',
						fields: [
							{ key: 'body', value: '[x](https://evil.example) <script>1</script>', kind: 'body' }
						]
					}
				}
			],
			details: true
		});
		expect(text).toContain('sushii-agent needs your approval to run');
		expect(text).toContain('[x](https://evil.example) <script>1</script>');
		expect(text).toContain('(self-reported)');
		expect(els.some((e) => e.tag === 'a' || e.tag === 'script' || e.tag === 'b')).toBe(false);
		expect(els.find((e) => e.tag === 'section')?.attrs['data-surface']).toBe('approval');
		const approve = els.find(
			(e) => e.tag === 'button' && e.attrs['aria-label']?.startsWith('Approve')
		);
		expect(approve?.attrs).toHaveProperty('disabled');
		const buttons = els.filter((e) => e.tag === 'button').map((e) => e.attrs['aria-label']);
		expect(buttons.indexOf('Deny send_email')).toBeLessThan(buttons.indexOf('Approve send_email'));
	});
});

describe('compact inline activity', () => {
	test('thinking has a small status and no expandable task card', async () => {
		const { els, text } = await dom(WorkingRow, {
			turn: { state: 'thinking', steps: [], label: 'Thinking…' }
		});
		expect(text).toContain('Thinking…');
		expect(els.filter((e) => e.tag === 'details')).toHaveLength(0);
		expect(els.some((e) => e.attrs.role === 'status')).toBe(true);
	});

	test('an approval without execution evidence never claims the tool finished', async () => {
		const { default: ToolRow } = await import('../components/tool-row.svelte');
		const { els, text } = await dom(ToolRow, {
			step: { id: 'legacy', tool: 'send_email', label: 'Send email', state: 'ok', input: '' },
			approval: { tool: 'send_email', outcome: 'approved' },
			executionUnknown: true
		});
		expect(text).toContain('Approved');
		expect(text).toContain('Execution status unavailable');
		expect(text).not.toContain('Finished');
		expect(els.filter((e) => e.tag === 'button')).toHaveLength(0);
	});

	test('approval shows structured fields, exact input and disabled submitting controls', async () => {
		const { default: ApprovalInline } = await import('../components/approval-inline.svelte');
		const { els, text } = await dom(ApprovalInline, {
			pending: {
				nonce: 'n1',
				view: {
					tool: 'send_email',
					agentId: 'main',
					agentName: 'Main',
					fields: [
						{ key: 'to', value: 'alex@example.com', kind: 'single', max: 100 },
						{ key: 'subject', value: 'Updated plan', kind: 'single', max: 100 },
						{ key: 'body', value: 'Full message', kind: 'body' }
					]
				}
			},
			submitting: true
		});
		expect(text).toContain('Send email');
		expect(text).toContain('Subject');
		expect(text).toContain('Exact input');
		expect(text).toContain('Submitting');
		expect(els.filter((e) => e.tag === 'button').every((e) => 'disabled' in e.attrs)).toBe(true);
	});
});

describe('grouped tool activity', () => {
	test('openStep expands the containing group and its individual call without dropping output', async () => {
		const { default: ToolActivityGroup } = await import('../components/tool-activity-group.svelte');
		const { els, text } = await dom(ToolActivityGroup, {
			steps: [
				{
					id: 'read1',
					tool: 'read',
					label: 'Read tasks',
					state: 'ok',
					input: 'TASKS.md',
					output: 'Task content'
				},
				{ id: 'bash1', tool: 'bash', label: 'Run check', state: 'running', input: 'bun test' }
			],
			openStep: 'read1'
		});
		const details = els.filter((e) => e.tag === 'details');
		expect(details).toHaveLength(3);
		expect(details.map((e) => 'open' in e.attrs)).toEqual([true, true, false]);
		expect(text).toContain('Task content');
		expect(text).toContain('Read × 1');
		expect(text).toContain('Bash × 1');
		expect(text).toContain('Running');
	});
	test('completed multi-call groups start collapsed', async () => {
		const { default: ToolActivityGroup } = await import('../components/tool-activity-group.svelte');
		const { els } = await dom(ToolActivityGroup, {
			steps: [1, 2].map((id) => ({
				id: String(id),
				tool: 'read',
				label: 'Read tasks',
				state: 'ok',
				input: 'TASKS.md'
			}))
		});
		expect(els.filter((e) => e.tag === 'details').every((e) => !('open' in e.attrs))).toBe(true);
	});
});

test('legacy grouped steps with repeated ids render every occurrence', async () => {
	const { els, text } = await dom(WorkingRow, {
		turn: {
			state: 'done',
			steps: [
				{ id: 'repeated', tool: 'read', label: 'Read first', state: 'ok', input: 'first.md' },
				{ id: 'repeated', tool: 'read', label: 'Read second', state: 'ok', input: 'second.md' }
			]
		}
	});
	expect(els.filter((e) => 'data-tool-call' in e.attrs)).toHaveLength(2);
	expect(text).toContain('first.md');
	expect(text).toContain('second.md');
});

describe('tool confirmations', () => {
	test('typed pending confirmation uses permission controls and exact command', async () => {
		const { els, text } = await dom(AskCard, {
			ask: {
				askId: 'a',
				question: 'Confirm command?',
				choices: ['Yes', 'No'],
				state: 'pending',
				toolConfirmation: {
					tool: 'bash',
					input: 'ws-consolidate --status',
					reason: 'Review command'
				}
			}
		});
		expect(els.some((e) => e.attrs['data-surface'] === 'tool-confirmation')).toBe(true);
		expect(text).toContain('Approval needed');
		expect(text).toContain('ws-consolidate --status');
		expect(text).toContain('Approve');
		expect(text).toContain('Deny');
		expect(els.some((e) => e.tag === 'input')).toBe(false);
	});
	test('resolved confirmation shows approved without inventing execution and keeps reason distinct from output', async () => {
		const { els, text } = await dom(AskCard, {
			ask: {
				askId: 'a',
				question: 'Confirm command?',
				choices: ['Yes', 'No'],
				state: 'answered',
				answer: 'Yes',
				toolConfirmation: { tool: 'bash', input: 'pwd', reason: 'Review command' }
			}
		});
		expect(text).toContain('Approved');
		expect(text).toContain('Execution status unavailable');
		expect(text).toContain('Reason');
		expect(text).not.toContain('Output');
		expect(text).not.toContain('Finished');
		expect(els.filter((e) => e.tag === 'details').every((e) => !('open' in e.attrs))).toBe(true);
	});
	test('a text-only legacy tool question stays a question instead of gaining approval authority', async () => {
		const { els, text } = await dom(AskCard, {
			ask: {
				askId: 'a',
				question: "Auto mode: allow this tool call?\nbash: pwd\n\nWhy it's asking: Review command",
				choices: ['Yes', 'No'],
				state: 'answered',
				answer: 'Yes'
			}
		});
		expect(els.some((e) => e.attrs['data-surface'] === 'tool-confirmation')).toBe(false);
		expect(text).toContain('Answered Yes');
		expect(text).not.toContain('Approved');
		expect(text).not.toContain('Finished');
	});
});
