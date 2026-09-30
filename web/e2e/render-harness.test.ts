import { expect, test, type Page } from '@playwright/test';

// Drives the render components in Chromium, under the gateway's Trusted Types policy. The depth
// payloads live here rather than only in bun tests because JSC overflows on them only sometimes.
const HARNESS = 'http://localhost:4174/';

type Win = {
	h: {
		api: {
			messages: { text: string }[];
			counter: number;
			approved: string[];
			steps: { id: string; tool: string; label: string; state: string; input: string }[];
			chat: unknown[];
			push(text: string, files?: unknown): void;
			setTray(nonces: string[] | null): void;
		};
		errors: string[];
		flushSync(): void;
		parse(text: string): { ok: boolean; kinds?: string[]; err?: string; ms: number };
		render(text: string, props?: Record<string, unknown>): { ok: boolean; err?: string };
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
		await expect(page.locator('#steps li')).toHaveCount(2);
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
