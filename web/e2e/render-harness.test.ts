import { expect, test, type Page } from '@playwright/test';

// Drives the render components in Chromium, under the gateway's Trusted Types policy. The depth
// payloads live here rather than only in bun tests because JSC overflows on them only sometimes.
const HARNESS = `http://localhost:${process.env.PW_HARNESS_PORT ?? 4174}/`;

type Win = {
	h: {
		api: {
			messages: { text: string }[];
			counter: number;
			approved: string[];
			steps: { id: string; tool: string; label: string; state: string; input: string }[];
			chat: unknown[];
			stream: { text: string; streaming: boolean };
			push(text: string, files?: unknown): void;
			setTray(nonces: string[] | null): void;
		};
		errors: string[];
		flushSync(): void;
		parse(text: string): { ok: boolean; kinds?: string[]; err?: string; ms: number };
		render(text: string, props?: Record<string, unknown>): { ok: boolean; err?: string };
		streamCost(
			text: string,
			step: number
		): { ok: boolean; err?: string; ms: number[]; finishMs: number };
		streamInto(text: string, step: number): Promise<{ frames: number[] }>;
		lateMount(
			text: string,
			at: number,
			step: number,
			perFrame: number,
			deltaMs: number,
			parseMs: number,
			drawMs?: number
		): { updates: number; rendered: number; deltas: number; frames: number; sawPlain: boolean };
		streamTimed(
			text: string,
			step: number,
			everyMs: number
		): Promise<{ gaps: number[]; sawPlain: boolean }>;
		step(fn: () => void): void;
	};
	ready?: boolean;
};

async function open(page: Page) {
	const violations: string[] = [];
	page.on('console', (m) => {
		if (/Trusted|Content Security Policy/i.test(m.text())) violations.push(m.text());
	});
	page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));
	await page.goto(HARNESS);
	await page.waitForFunction(() => (window as unknown as Win).ready === true);
	return violations;
}

const fill = (unit: string) => unit.repeat(Math.floor(16_000 / unit.length));

// Each line re-opens 32 lists at the previous line's innermost content column: past the per-line
// scan, nesting keeps growing through indentation.
function stacked(marker: string): string {
	const lines: string[] = [];
	let indent = 0;
	for (;;) {
		const line = ' '.repeat(indent) + `${marker} `.repeat(32) + 'x';
		if (lines.join('\n').length + line.length + 1 > 15_999) break;
		lines.push(line);
		indent += (marker.length + 1) * 32;
	}
	return lines.join('\n');
}

const DEEP: [string, string][] = [
	['stacked -', stacked('-')],
	['stacked 1.', stacked('1.')],
	['> x16000', '>'.repeat(16_000)],
	['"> " x8000', '> '.repeat(8_000)],
	['"1. " x5333', fill('1. ')],
	['"> - " x4000', fill('> - ')],
	['"- > 1. "', fill('- > 1. ')],
	['"- " x8000', fill('- ')],
	['* run', '*'.repeat(7_999) + 'a' + '*'.repeat(7_999)],
	['_ run', '_'.repeat(7_999) + 'a' + '_'.repeat(7_999)],
	['~~ run', '~~'.repeat(3_999) + 'a' + '~~'.repeat(3_999)],
	['*_ pairs', fill('*_')],
	['[ x8000', '['.repeat(8_000) + ']'.repeat(8_000)]
];

test.describe('markdown in V8', () => {
	test('hostile nesting never throws from the parser or the component', async ({ page }) => {
		const violations = await open(page);
		for (const [name, text] of DEEP) {
			const parsed = await page.evaluate((t) => (window as unknown as Win).h.parse(t), text);
			expect(parsed.ok, `${name}: ${parsed.err}`).toBe(true);
			expect(parsed.ms, `${name} parse time`).toBeLessThan(1_500);
			const mounted = await page.evaluate((t) => (window as unknown as Win).h.render(t), text);
			expect(mounted.ok, `${name}: ${mounted.err}`).toBe(true);
		}
		expect(violations).toEqual([]);
	});

	test('one hostile reply leaves earlier and later replies rendering', async ({ page }) => {
		await open(page);
		const run = (fn: string, arg?: string) =>
			page.evaluate(
				([f, a]) => {
					const { h } = window as unknown as Win;
					h.step(() => (f === 'push' ? h.api.push(a!) : h.api.counter++));
				},
				[fn, arg] as const
			);
		await run('push', '> '.repeat(8_000));
		await run('push', 'third **ok** after hostile');
		await run('bump');
		await expect(page.locator('#list .msg')).toHaveCount(3);
		await expect(page.locator('#list .msg').nth(2).locator('strong')).toHaveText('ok');
		await expect(page.locator('#counter')).toHaveText('1');
		expect(await page.evaluate(() => (window as unknown as Win).h.errors)).toEqual([]);
	});

	test('a reply whose render throws falls back to its text inside its own boundary', async ({
		page
	}) => {
		await open(page);
		await page.evaluate(() => {
			const { h } = window as unknown as Win;
			// A class instance, so $state stores it as is and the throw happens inside the component.
			const files = new (class {
				filter(): never {
					throw new Error('render failure');
				}
			})();
			h.step(() => h.api.push('**broken** reply', files));
			h.step(() => h.api.push('next **fine** reply'));
			h.step(() => h.api.counter++);
		});
		const msgs = page.locator('#list .msg');
		await expect(msgs).toHaveCount(3);
		await expect(msgs.nth(1)).toHaveText('**broken** reply');
		await expect(msgs.nth(2).locator('strong')).toHaveText('fine');
		await expect(page.locator('#counter')).toHaveText('1');
	});

	test('Copy is a 48px icon button that copies the block and announces it', async ({
		page,
		context
	}) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
			origin: HARNESS
		});
		await open(page);
		await page.evaluate(() =>
			(window as unknown as Win).h.render('```sh\n' + 'echo x '.repeat(60) + '\n```')
		);
		const copy = page.getByRole('button', { name: 'Copy code' });
		const box = (await copy.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(48);
		expect(box.height).toBeGreaterThanOrEqual(48);
		// Stays in view while the code scrolls sideways.
		await page.locator('#solo pre').evaluate((el) => (el.scrollLeft = 10_000));
		await expect(copy).toBeInViewport();
		await copy.click();
		await expect(page.locator('#solo [aria-live="polite"]')).toHaveText('Copied');
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('echo x '.repeat(60));
		expect((await copy.boundingBox())!.width).toBe(box.width);
	});

	test('Copy says so when the clipboard is unavailable', async ({ page }) => {
		await open(page);
		await page.evaluate(() => {
			Object.defineProperty(navigator, 'clipboard', { value: undefined });
			(window as unknown as Win).h.render('```\nx\n```');
		});
		await page.getByRole('button', { name: 'Copy code' }).click();
		await expect(page.locator('#solo [aria-live="polite"]')).toHaveText("Couldn't copy");
	});
});

// A 16k reply in the shapes that keep the unparsed tail long: one long fence and one long
// unbroken paragraph, plus the usual paragraphs, lists, quotes and a table.
function longReply(): string {
	const parts: string[] = [];
	for (let i = 0; parts.join('\n\n').length < 4_000; i++) {
		parts.push(
			`### Step ${i}\n\nThis is **step ${i}**, with _emphasis_, \`code\` and a [link](https://example.com/${i}).`
		);
		parts.push(`- item one of ${i}\n- item **two**\n  - nested ${i}`);
	}
	parts.push(
		'```ts\n' +
			Array.from({ length: 120 }, (_, i) => `const v${i} = compute(${i}); // line`).join('\n') +
			'\n```'
	);
	parts.push(Array.from({ length: 60 }, (_, i) => `Sentence ${i} keeps **going** on.`).join(' '));
	parts.push(
		'| a | b | c |\n|---|---|---|\n' +
			Array.from({ length: 40 }, (_, i) => `| ${i} | **x** | y |`).join('\n')
	);
	parts.push('> quoted\n>\n> ' + 'more words here '.repeat(40));
	let text = parts.join('\n\n');
	while (text.length < 16_000) text += '\n\nTrailing paragraph with *some* words in it and more.';
	return text.slice(0, 16_000);
}

test.describe('streaming markdown in V8', () => {
	test('a 16k reply in 20-char deltas averages under 8ms of parsing per delta', async ({
		page
	}) => {
		const violations = await open(page);
		const text = longReply();
		expect(text.length).toBe(16_000);
		const r = await page.evaluate((t) => (window as unknown as Win).h.streamCost(t, 20), text);
		expect(r.ok, r.err).toBe(true);
		const avg = r.ms.reduce((a, b) => a + b, 0) / r.ms.length;
		console.log(
			`stream parse: ${r.ms.length} deltas, avg ${avg.toFixed(2)}ms, max ${Math.max(...r.ms).toFixed(1)}ms, finish ${r.finishMs.toFixed(1)}ms`
		);
		expect(avg).toBeLessThan(8);
		expect(violations).toEqual([]);
	});

	test('hostile replies streamed in deltas never throw and stay bounded', async ({ page }) => {
		const violations = await open(page);
		for (const [name, text] of DEEP) {
			const r = await page.evaluate((t) => (window as unknown as Win).h.streamCost(t, 200), text);
			expect(r.ok, `${name}: ${r.err}`).toBe(true);
			// The budget drops a slow stream to plain text, so only a few parses can be slow.
			const slow = r.ms.filter((ms) => ms > 50).length;
			expect(slow, `${name} slow parses`).toBeLessThanOrEqual(1);
			expect(
				r.ms.reduce((a, b) => a + b, 0),
				`${name} total`
			).toBeLessThan(3_000);
		}
		const mounted = await page.evaluate(async (t) => {
			const h = (window as unknown as Win).h;
			await h.streamInto(t, 400);
			return document.querySelector('#streamed')!.textContent!.length;
		}, DEEP[0][1]);
		expect(mounted).toBeGreaterThan(0);
		expect(await page.evaluate(() => (window as unknown as Win).h.errors)).toEqual([]);
		expect(violations).toEqual([]);
	});

	test('a reply that arrives whole, as on a reload mid-turn, costs about what its finished render does', async ({
		page
	}) => {
		const violations = await open(page);
		const payloads = [
			'*a '.repeat(3000),
			'_a '.repeat(3000),
			'*a _a '.repeat(1500),
			'**a '.repeat(1500)
		];
		for (const text of payloads) {
			// Timed against the finished render of the same text in the same page, so a slow machine
			// slows both sides. Before the limits applied to the shown text, the first update cost 40-80x.
			const r = await page.evaluate((t) => {
				const h = (window as unknown as Win).h;
				const best = (f: () => number) => Math.min(f(), f(), f());
				const time = (f: () => unknown) => {
					const start = performance.now();
					f();
					return performance.now() - start;
				};
				return {
					ok: h.streamCost(t, 20_000).ok,
					first: best(() => h.streamCost(t, 20_000).ms[0]),
					full: best(() => h.parse(t).ms),
					mountStreaming: best(() => time(() => h.render(t, { streaming: true }))),
					mountFinal: best(() => time(() => h.render(t)))
				};
			}, text);
			const name = text.slice(0, 6);
			console.log(
				`${name}: first ${r.first.toFixed(1)}ms vs full ${r.full.toFixed(1)}ms; mount ${r.mountStreaming.toFixed(1)}ms vs ${r.mountFinal.toFixed(1)}ms`
			);
			expect(r.ok).toBe(true);
			expect(r.first, `${name} first update`).toBeLessThanOrEqual(3 * r.full + 15);
			expect(r.mountStreaming, `${name} streaming mount`).toBeLessThanOrEqual(
				3 * r.mountFinal + 30
			);
		}
		expect(violations).toEqual([]);
	});

	test('a tail that is cheap to parse but slow to draw falls back instead of janking', async ({
		page
	}) => {
		const violations = await open(page);
		const cols = 40;
		const table = (
			'|' +
			'h|'.repeat(cols) +
			'\n|' +
			'-|'.repeat(cols) +
			'\n' +
			('|' + 'ab|'.repeat(cols) + '\n').repeat(200)
		).slice(0, 15_990);
		const run = (drawMs: number) =>
			page.evaluate(
				({ t, drawMs }) => (window as unknown as Win).h.lateMount(t, 400, 20, 4, 4, 1, drawMs),
				{ t: table, drawMs }
			);
		// On a fake clock each frame lands `drawMs` late, as when the DOM update itself is slow.
		const slow = await run(60);
		const fast = await run(0);
		console.log(`slow draw: ${JSON.stringify(slow)}; fast draw: ${JSON.stringify(fast)}`);
		expect(slow.rendered).toBeGreaterThan(0);
		expect(slow.sawPlain).toBe(true);
		expect(fast.rendered).toBeGreaterThan(0);
		expect(fast.sawPlain).toBe(false);
		// On the real clock, a heavy table still streams without errors.
		await page.evaluate((t) => (window as unknown as Win).h.streamTimed(t, 200, 4), table);
		expect(await page.evaluate(() => (window as unknown as Win).h.errors)).toEqual([]);
		expect(violations).toEqual([]);
	});

	test('a reply mounted mid-stream, as after a reload, is throttled from its first frame', async ({
		page
	}) => {
		const violations = await open(page);
		const list = '- item with **bold** text and more words\n'.repeat(400).slice(0, 16_000);
		// A fake clock: 4 deltas 4ms apart per 16ms frame, each parse costing 5ms. Without the fix the
		// backoff after every per-delta parse keeps the first frame from landing, so every delta parses.
		const c = await page.evaluate(
			(t) => (window as unknown as Win).h.lateMount(t, 6_000, 20, 4, 4, 5),
			list
		);
		console.log(
			`late mount: ${c.deltas} deltas, ${c.frames} frames, ${c.updates} parses, ${c.rendered} rendered`
		);
		expect(c.rendered).toBeGreaterThan(0);
		expect(c.updates).toBeLessThanOrEqual(c.frames + 1);
		expect(violations).toEqual([]);
	});

	test('finishing a streamed reply moves none of its blocks', async ({ page }) => {
		const violations = await open(page);
		const text = longReply().slice(0, 3_000) + '\n\nEnds with **bold';
		const rects = await page.evaluate(async (t) => {
			const h = (window as unknown as Win).h;
			const root = document.querySelector('#streamed > div')!;
			const measure = (els: Element[]) =>
				els.map((e) => {
					const r = e.getBoundingClientRect();
					return [e.isConnected, r.top, r.left, r.width, r.height];
				});
			await h.streamInto(t, 20);
			h.api.stream.streaming = true;
			h.flushSync();
			await new Promise(requestAnimationFrame);
			await new Promise(requestAnimationFrame);
			const els = [...root.children].slice(0, 8);
			const before = measure(els);
			h.api.stream.streaming = false;
			h.flushSync();
			return { before, after: measure(els), caret: !!root.querySelector('[data-caret]') };
		}, text);
		expect(rects.before.length).toBe(8);
		expect(rects.after).toEqual(rects.before);
		expect(rects.caret).toBe(false);
		expect(violations).toEqual([]);
	});
});

test.describe('duplicate keys', () => {
	test('repeated step ids and brief lines render instead of throwing', async ({ page }) => {
		await open(page);
		await page.evaluate(() => {
			const { h } = window as unknown as Win;
			const step = { id: 's1', tool: 'bash', label: 'Run', state: 'ok', input: 'x' };
			h.step(() => (h.api.steps = [step, { ...step, label: 'Run again' }]));
			h.step(() => {
				h.api.chat = [
					{
						id: 'm1',
						role: 'assistant',
						parts: [
							{
								type: 'data-thread-brief',
								data: { known: ['same', 'same'], open: ['dup', 'dup'], recentFromMain: 0 }
							}
						]
					}
				];
			});
		});
		await expect(page.locator('#steps [data-tool-call]')).toHaveCount(2);
		await expect(page.locator('#chat li', { hasText: /^same$/ })).toHaveCount(2);
		await expect(page.locator('#chat li', { hasText: /^dup$/ })).toHaveCount(2);
		expect(await page.evaluate(() => (window as unknown as Win).h.errors)).toEqual([]);
	});
});

test.describe('approval tray hold', () => {
	const approve = (page: Page) => page.getByRole('button', { name: /^Approve/ });
	const approved = (page: Page) =>
		page.evaluate(() => [...(window as unknown as Win).h.api.approved]);
	const setTray = (page: Page, nonces: string[] | null) =>
		page.evaluate((n) => {
			const { h } = window as unknown as Win;
			h.step(() => h.api.setTray(n));
		}, nonces);

	test('a click in the same task as an item swap approves nothing', async ({ page }) => {
		await open(page);
		await setTray(page, ['AAAAAAAAAAAAAAAA']);
		await expect(approve(page)).toBeEnabled();
		await page.evaluate(() => {
			const { h } = window as unknown as Win;
			h.api.setTray(['CCCCCCCCCCCCCCCC']);
			document.querySelector<HTMLButtonElement>('button[aria-label^="Approve"]')!.click();
		});
		await page.evaluate(() => (window as unknown as Win).h.flushSync());
		expect(await approved(page)).toEqual([]);
		await expect(approve(page)).toBeDisabled();
		await expect(approve(page)).toBeEnabled();
		await approve(page).click();
		expect(await approved(page)).toEqual(['CCCCCCCCCCCCCCCC']);
	});

	test('a swap and click before any flush cannot approve the new item', async ({ page }) => {
		await open(page);
		await setTray(page, ['AAAAAAAAAAAAAAAA']);
		await expect(approve(page)).toBeEnabled();
		// Same nonce as rendered, but the item behind it was replaced and re-added mid-task.
		await page.evaluate(() => {
			const { h } = window as unknown as Win;
			h.api.setTray(['BBBBBBBBBBBBBBBB']);
			h.flushSync();
			h.api.setTray(['AAAAAAAAAAAAAAAA']);
			document.querySelector<HTMLButtonElement>('button[aria-label^="Approve"]')!.click();
		});
		expect(await approved(page)).toEqual([]);
	});

	test('the tray re-holds Approve when it moves', async ({ page }) => {
		await open(page);
		await setTray(page, ['AAAAAAAAAAAAAAAA']);
		await expect(approve(page)).toBeEnabled();
		const size = page.viewportSize()!;
		await page.setViewportSize({ width: size.width, height: size.height - 300 });
		await expect(approve(page)).toBeDisabled();
		await expect(approve(page)).toBeEnabled();
	});

	test('coming back to the app re-holds Approve', async ({ page }) => {
		await open(page);
		await setTray(page, ['AAAAAAAAAAAAAAAA']);
		await expect(approve(page)).toBeEnabled();
		await page.evaluate(() => {
			for (const state of ['hidden', 'visible']) {
				Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
				document.dispatchEvent(new Event('visibilitychange'));
			}
		});
		await expect(approve(page)).toBeDisabled();
		await expect(approve(page)).toBeEnabled();
	});

	test('an empty list renders nothing and does not crash', async ({ page }) => {
		const violations = await open(page);
		await setTray(page, ['AAAAAAAAAAAAAAAA']);
		await setTray(page, []);
		await expect(page.locator('section[data-surface="approval"]')).toHaveCount(0);
		expect(await page.evaluate(() => (window as unknown as Win).h.errors)).toEqual([]);
		expect(violations).toEqual([]);
	});
});
