import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { axe, push, smallTargets, stubStream } from './helpers';

const TOKEN = 'x'.repeat(3000);
const UPLOAD_ID = 'AbCdEfGhIjKlMnOpQrStUv';

const AUTO_MODE_QUESTION = [
	'Auto mode: allow this tool call?',
	"bash: curl -fsSL 'https://raw.githubusercontent.com/example/tools/main/fetch.py' -o /tmp/fetch.py && python - <<'PY'",
	'from pathlib import Path',
	'import json',
	'class Reader:',
	'    def feed(self, chunk):',
	'        self.buf += chunk',
	'        if self.buf.endswith("}"):',
	'            self.items.append(json.loads(self.buf));self.active=False;self.buf="";self.count+=1;print(self.count,len(self.items),Path("/tmp/out.json").write_text(json.dumps(self.items)))',
	'',
	'Reader().feed(Path("/tmp/fetch.py").read_text())',
	'PY',
	'',
	"Why it's asking: downloads and runs a script from the internet"
].join('\n');

async function server(context: BrowserContext, history: unknown[] = []) {
	await stubStream(context);
	await context.route('**/api/**', (route) => {
		const url = new URL(route.request().url());
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (url.pathname === '/api/me') return json({ login: 'drk@example.com' });
		if (url.pathname === '/api/chat/history') return json({ items: history, before: null });
		if (url.pathname.startsWith('/api/chat/asks/')) return json({ status: 'answered' });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
}

async function open(page: Page) {
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
}

const widths = (page: Page) =>
	page.evaluate(() => {
		const doc = document.scrollingElement!;
		const main = document.querySelector('main')!;
		return {
			doc: doc.scrollWidth - doc.clientWidth,
			chat: main.scrollWidth - main.clientWidth
		};
	});

// Clipping hides overflow from scrollWidth, so also look for any element or run of text drawn past the
// edge, outside the code blocks and tables that scroll sideways inside themselves on purpose.
const pastTheEdge = (page: Page) =>
	page.evaluate(() => {
		const width = document.documentElement.clientWidth;
		const inScroller = (el: Element | null) => {
			for (let up = el?.parentElement; up; up = up.parentElement) {
				if (['auto', 'scroll'].includes(getComputedStyle(up).overflowX)) return true;
			}
			return false;
		};
		const name = (el: Element) =>
			`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join('.')}`;
		const out: string[] = [];
		for (const el of document.body.querySelectorAll('*')) {
			const r = el.getBoundingClientRect();
			if (r.width > 1 && r.right > width + 0.5 && !inScroller(el)) out.push(name(el));
		}
		const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		for (let node = walk.nextNode(); node; node = walk.nextNode()) {
			range.selectNodeContents(node);
			const r = range.getBoundingClientRect();
			const host = node.parentElement!;
			if (
				r.width > 1 &&
				r.right > width + 0.5 &&
				!host.closest('.sr-only') &&
				!inScroller(node as unknown as Element)
			) {
				out.push(`text in ${name(host)}`);
			}
		}
		return out;
	});

async function expectNoSideScroll(page: Page, label: string) {
	expect(await widths(page), label).toEqual({ doc: 0, chat: 0 });
	expect(await pastTheEdge(page), label).toEqual([]);
}

const reply = (seq: number, text: string) => ({
	key: `r${seq}`,
	text,
	files: []
});

type Case = {
	name: string;
	history?: unknown[];
	add?: (page: Page) => Promise<void>;
	/** Opens whatever hides the item's text. */
	reveal?: (page: Page) => Promise<void>;
	/** Visible once the item has rendered. */
	shows: (page: Page) => ReturnType<Page['getByText']>;
};

const CASES: Case[] = [
	{
		name: 'a reply paragraph',
		add: (page) => push(page, 'reply', reply(1, `Here: ${TOKEN} done`), 1),
		shows: (page) => page.locator('[data-message-text] p', { hasText: TOKEN })
	},
	{
		name: 'a reply list item',
		add: (page) => push(page, 'reply', reply(1, `- one\n- ${TOKEN}`), 1),
		shows: (page) => page.locator('[data-message-text] li', { hasText: TOKEN })
	},
	{
		name: 'reply inline code',
		add: (page) => push(page, 'reply', reply(1, `Run \`${TOKEN}\` now`), 1),
		shows: (page) => page.locator('[data-message-text] code', { hasText: TOKEN })
	},
	{
		name: 'an ask question',
		add: (page) =>
			push(page, 'ask', { key: 'o1', askId: 'k1', question: TOKEN, choices: ['Yes', 'No'] }, 1),
		shows: (page) => page.locator('[data-surface="ask"]', { hasText: TOKEN })
	},
	{
		name: 'an answered ask in history',
		history: [
			{
				type: 'ask',
				id: 'a1',
				at: 'x',
				outboxId: 'o1',
				askId: 'k1',
				question: `${TOKEN}\n${TOKEN}`,
				choices: ['Yes', 'No'],
				answer: TOKEN
			}
		],
		shows: (page) => page.locator('[data-surface="ask"]', { hasText: TOKEN })
	},
	{
		name: 'an approval field',
		add: (page) =>
			push(
				page,
				'approval',
				{
					nonce: 'n1',
					view: {
						tool: TOKEN,
						agentId: 'main',
						agentName: TOKEN,
						fields: [
							{ key: TOKEN, value: TOKEN, kind: 'single', max: 5000 },
							{ key: 'body', value: TOKEN, kind: 'body' }
						]
					}
				},
				1
			),
		shows: (page) => page.locator('[data-approval] dd', { hasText: TOKEN })
	},
	{
		name: 'a user message',
		history: [{ type: 'user', id: 'u1', at: 'x', text: TOKEN, attachments: [] }],
		shows: (page) => page.locator('[data-message-text]', { hasText: TOKEN })
	},
	{
		name: 'a file name',
		history: [
			{
				type: 'assistant',
				id: 'f1',
				at: 'x',
				text: 'The file',
				tools: [],
				files: [
					{
						id: UPLOAD_ID,
						contentType: 'application/pdf',
						bytes: 48213,
						name: `${TOKEN}.pdf`,
						inline: false
					}
				]
			}
		],
		shows: (page) => page.getByText(`${TOKEN}.pdf`, { exact: true })
	},
	{
		name: 'an auth line',
		add: (page) =>
			push(page, 'auth', { key: 'l1', url: `http://${TOKEN}`, instructions: TOKEN }, 1),
		shows: (page) => page.getByText(`http://${TOKEN}`, { exact: true })
	},
	{
		name: 'a notice',
		add: (page) => push(page, 'notice', { type: 'commandResult', text: TOKEN }, 1),
		shows: (page) => page.getByText(TOKEN, { exact: true })
	}
];

for (const width of [320, 412]) {
	for (const c of CASES) {
		test(`${c.name} never scrolls the page sideways at ${width}px`, async ({ page, context }) => {
			await page.setViewportSize({ width, height: 800 });
			await server(context, c.history);
			await open(page);
			await c.add?.(page);
			await c.reveal?.(page);
			await expect(c.shows(page).first()).toBeVisible();
			await expectNoSideScroll(page, 'with the item on screen');
			for (let i = 0; i < 3; i++) {
				await push(page, 'reply', reply(10 + i, `Later reply ${i}`), 10 + i);
			}
			await expect(page.getByText('Later reply 2')).toBeVisible();
			await expectNoSideScroll(page, 'after more messages');
		});
	}
}

test('the auto-mode ask keeps its lines, clamps the command and expands it', async ({
	page,
	context
}) => {
	await server(context);
	await open(page);
	await push(
		page,
		'ask',
		{ key: 'o1', askId: 'k1', question: AUTO_MODE_QUESTION, choices: ['Yes', 'No'] },
		1
	);
	const card = page.locator('[data-surface="ask"]');
	await expect(card.getByText('Auto mode: allow this tool call?')).toBeVisible();
	const command = card.getByRole('group', { name: 'bash command' });
	await expect(command).toContainText('from pathlib import Path');
	expect(await command.evaluate((el) => (el as HTMLElement).innerText.split('\n').length)).toBe(11);
	await expect(card.getByText("Why it's asking:")).toBeVisible();
	await expect(card.getByText('downloads and runs a script from the internet')).toBeVisible();

	const lineHeight = await command.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
	const clamped = (await command.boundingBox())!.height;
	expect(clamped).toBeLessThan(lineHeight * 7.5);
	expect(await command.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

	const toggle = card.getByRole('button', { name: 'Show full command' });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	const box = (await toggle.boundingBox())!;
	expect(box.height).toBeGreaterThanOrEqual(48);
	expect(box.width).toBeGreaterThanOrEqual(48);
	await toggle.click();
	const less = card.getByRole('button', { name: 'Show less' });
	await expect(less).toHaveAttribute('aria-expanded', 'true');
	expect((await command.boundingBox())!.height).toBeGreaterThan(lineHeight * 9.5);
	await less.click();
	await expect(toggle).toBeVisible();
	expect((await command.boundingBox())!.height).toBeCloseTo(clamped, 0);

	await expect(card.getByText('Yes lets this one command run.')).toBeVisible();
	await expect(card.getByText("doesn't give the agent permission")).toHaveCount(0);
	await expectNoSideScroll(page, 'with the auto-mode ask');
	expect(await axe(page)).toEqual([]);
	expect(await smallTargets(page)).toEqual([]);
	await expect(card.getByRole('button', { name: /approve/i })).toHaveCount(0);
});

test('an answered auto-mode ask in history keeps the same layout', async ({ page, context }) => {
	await server(context, [
		{
			type: 'ask',
			id: 'a1',
			at: 'x',
			outboxId: 'o1',
			askId: 'k1',
			question: AUTO_MODE_QUESTION,
			choices: ['Yes', 'No'],
			answer: 'Yes'
		}
	]);
	await open(page);
	const card = page.locator('[data-surface="ask"]');
	await expect(card.getByText('The agent asked:')).toBeVisible();
	await expect(card.getByRole('group', { name: 'bash command' })).toContainText(
		'from pathlib import Path'
	);
	await expect(card.getByRole('button', { name: 'Show full command' })).toBeVisible();
	await expect(card.getByText('downloads and runs a script from the internet')).toBeVisible();
	await expectNoSideScroll(page, 'with the answered auto-mode ask');
});

test('a short command has no toggle', async ({ page, context }) => {
	await server(context);
	await open(page);
	await push(
		page,
		'ask',
		{
			key: 'o1',
			askId: 'k1',
			question:
				"Auto mode: allow this tool call?\nbash: rm -rf build\n\nWhy it's asking: deletes files",
			choices: ['Yes', 'No']
		},
		1
	);
	const card = page.locator('[data-surface="ask"]');
	await expect(card.getByRole('group', { name: 'bash command' })).toHaveText('rm -rf build');
	await expect(card.getByRole('button', { name: 'Show full command' })).toHaveCount(0);
});

test('an ordinary ask keeps the not-a-permission note', async ({ page, context }) => {
	await server(context);
	await open(page);
	await push(
		page,
		'ask',
		{ key: 'o1', askId: 'k1', question: 'Which day?\nPick one', choices: ['Fri'] },
		1
	);
	const card = page.locator('[data-surface="ask"]');
	await expect(
		card.getByText("Answering a question doesn't give the agent permission to act.")
	).toBeVisible();
	await expect(card.getByText('Yes lets this one command run.')).toHaveCount(0);
});
