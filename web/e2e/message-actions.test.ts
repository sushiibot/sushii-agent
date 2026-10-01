import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { axe, horizontalOverflow, smallTargets, stubStream } from './helpers';

const item = (type: 'user' | 'assistant', id: string, text: string) => ({
	type,
	id,
	at: 'x',
	text,
	attachments: [],
	tools: [],
	files: []
});

const REPLY =
	'Booked **Eastside Auto** for _Saturday 09:00_.\n\n- Confirmation `BK-5520`\n- [Directions](https://example.com/map)';
const REPLY_PLAIN = 'Booked Eastside Auto for Saturday 09:00.\n\nConfirmation BK-5520\nDirections';

async function chatServer(context: BrowserContext, history: unknown[]) {
	const opts: { messageStatus: number | 'abort' } = { messageStatus: 202 };
	await stubStream(context);
	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (path === '/api/chat/history') return json({ items: history, before: null });
		if (path === '/api/chat/messages') {
			if (opts.messageStatus === 'abort') return route.abort();
			if (opts.messageStatus !== 202) return json({ error: 'bad' }, opts.messageStatus);
			return json({ seq: 1 }, 202);
		}
		if (path === '/api/chat/seen') return route.fulfill({ status: 204 });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	return opts;
}

async function open(page: Page) {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
}

const bubble = (page: Page, text: string) =>
	page.locator('[data-message-id]').filter({ hasText: text });
const row = (page: Page, text: string) =>
	bubble(page, text).getByRole('group', { name: /^Actions for/ });
const opacity = (page: Page, text: string) =>
	row(page, text).evaluate((e) => getComputedStyle(e).opacity);

function desktop(browser: Browser) {
	return browser.newContext({
		viewport: { width: 1280, height: 800 },
		isMobile: false,
		hasTouch: false
	});
}

test('Copy and Share sit under the reply; Copy takes the rendered text and says so', async ({
	page,
	context
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.addInitScript(() => {
		const w = window as unknown as { __shared: unknown[] };
		w.__shared = [];
		navigator.share = async (data) => void w.__shared.push(data);
	});
	await chatServer(context, [
		item('user', 'u1', 'Book the car service'),
		item('assistant', 'r1', REPLY)
	]);
	await open(page);

	const reply = row(page, 'Booked Eastside');
	await expect(reply.getByRole('button')).toHaveText(['', '']);
	await expect(reply).toHaveAccessibleName('Actions for the reply');
	await expect(reply.getByRole('button', { name: 'Copy reply' })).toBeVisible();
	await expect(reply.getByRole('button', { name: 'Share reply' })).toBeVisible();
	await expect(reply.getByRole('button', { name: /approve|allow|run|deny/i })).toHaveCount(0);
	await expect(row(page, 'Book the car service').getByRole('button')).toHaveCount(1);
	await expect(
		row(page, 'Book the car service').getByRole('button', { name: 'Copy your message' })
	).toBeVisible();
	await expect(row(page, 'Book the car service')).toHaveAccessibleName('Actions for your message');

	const copy = reply.getByRole('button', { name: 'Copy' });
	const icon = await copy.innerHTML();
	await copy.click();
	await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeAttached();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPLY_PLAIN);
	expect(await copy.innerHTML()).not.toBe(icon);
	await expect.poll(() => copy.innerHTML(), { timeout: 5000 }).toBe(icon);

	await reply.getByRole('button', { name: 'Share' }).click();
	expect(
		await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)
	).toEqual([{ text: REPLY_PLAIN }]);
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('no Share where the browser has none', async ({ page, context }) => {
	await page.addInitScript(() => {
		delete (Navigator.prototype as { share?: unknown }).share;
	});
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	await expect(row(page, 'Booked Eastside').getByRole('button')).toHaveCount(1);
});

test('on a touch screen every row shows; with a mouse, older rows wait for hover or focus', async ({
	page,
	context,
	browser
}) => {
	const history = [
		item('user', 'u1', 'Book the car service'),
		item('assistant', 'r1', 'Booked the older one.'),
		item('user', 'u2', 'And the tyres'),
		item('assistant', 'r2', REPLY)
	];
	await chatServer(context, history);
	await open(page);
	for (const text of ['Book the car', 'older one', 'And the tyres', 'Booked Eastside']) {
		expect(await opacity(page, text)).toBe('1');
	}

	const mouse = await desktop(browser);
	await chatServer(mouse, history);
	const p = await mouse.newPage();
	await open(p);
	expect(await opacity(p, 'Booked Eastside')).toBe('1');
	expect(await opacity(p, 'older one')).toBe('0');
	expect(await opacity(p, 'Book the car')).toBe('0');
	const height = await row(p, 'older one').evaluate((e) => e.getBoundingClientRect().height);
	expect(height).toBe(48);

	await bubble(p, 'older one').locator('[data-message-text]').hover();
	await expect.poll(() => opacity(p, 'older one')).toBe('1');
	expect(await row(p, 'older one').evaluate((e) => e.getBoundingClientRect().height)).toBe(height);
	await p.mouse.move(0, 0);
	await expect.poll(() => opacity(p, 'older one')).toBe('0');

	await row(p, 'Book the car').getByRole('button', { name: 'Copy' }).focus();
	await expect.poll(() => opacity(p, 'Book the car')).toBe('1');

	// With a mouse, your own message's row sits beside the bubble and adds no height.
	const own = await bubble(p, 'And the tyres').evaluate((li) => {
		const text = li.querySelector('[data-message-text]')!.getBoundingClientRect();
		const group = li.querySelector('[role="group"]')!.getBoundingClientRect();
		return {
			li: li.getBoundingClientRect().height,
			text: text.height,
			groupRight: group.right,
			textLeft: text.left,
			groupBottom: group.bottom,
			textBottom: text.bottom
		};
	});
	expect(own.li).toBe(own.text);
	expect(own.groupRight).toBeLessThanOrEqual(own.textLeft);
	expect(own.groupBottom).toBe(own.textBottom);
	await bubble(p, 'And the tyres').locator('[data-message-text]').hover();
	await expect.poll(() => opacity(p, 'And the tyres')).toBe('1');
	expect(await bubble(p, 'And the tyres').evaluate((li) => li.getBoundingClientRect().height)).toBe(
		own.li
	);
	await mouse.close();
});

test('failed and queued messages keep Copy, Retry and Delete inline instead of a row', async ({
	page,
	context
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const opts = await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	opts.messageStatus = 400;
	await page.getByRole('textbox', { name: 'Message' }).fill('This one fails');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(bubble(page, 'This one fails')).toContainText('Failed');

	opts.messageStatus = 'abort';
	await context.setOffline(true);
	await page.getByRole('textbox', { name: 'Message' }).fill('This one waits');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(bubble(page, 'This one waits')).toContainText(
		"Queued, sends when you're back online"
	);

	for (const text of ['This one fails', 'This one waits']) {
		const b = bubble(page, text);
		await expect(b.getByRole('button', { name: 'Retry send' })).toBeVisible();
		await expect(b.getByRole('button', { name: 'Delete' })).toBeVisible();
		await expect(row(page, text)).toHaveCount(0);
		await b.getByRole('button', { name: 'Copy your message' }).click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
	}
	await context.setOffline(false);
});

test('right-click, middle-click and a touch hold are left to the browser', async ({
	page,
	context,
	browser
}) => {
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	const text = bubble(page, 'Booked Eastside').locator('[data-message-text]');
	await expect(text).not.toHaveCSS('user-select', 'none');
	await expect(text).not.toHaveCSS('-webkit-touch-callout', 'none');

	const mouse = await desktop(browser);
	await chatServer(mouse, [item('assistant', 'r1', REPLY)]);
	const p = await mouse.newPage();
	await open(p);
	await p.evaluate(() => {
		const w = window as unknown as { __prevented: string[] };
		w.__prevented = [];
		for (const type of ['contextmenu', 'pointerdown', 'mousedown', 'auxclick']) {
			// Bubble phase on window, after every app handler has run.
			window.addEventListener(type, (e) => {
				if (e.defaultPrevented) w.__prevented.push(type);
			});
		}
	});
	const target = bubble(p, 'Booked Eastside').locator('[data-message-text]');
	await target.click({ button: 'right' });
	await p.keyboard.press('Escape');
	await target.click({ button: 'middle' });
	const main = p.locator('main');
	const box = (await main.boundingBox())!;
	await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await p.mouse.down({ button: 'middle' });
	await p.mouse.up({ button: 'middle' });
	expect(
		await p.evaluate(() => (window as unknown as { __prevented: string[] }).__prevented)
	).toEqual([]);
	await expect(p.getByRole('dialog')).toHaveCount(0);
	await mouse.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`message rows pass axe, 48px targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await chatServer(context, [
			item('user', 'u1', 'Book the car service'),
			item('assistant', 'r1', REPLY)
		]);
		await open(page);
		await expect(row(page, 'Booked Eastside')).toBeVisible();
		expect(await axe(page)).toEqual([]);
		expect(await smallTargets(page)).toEqual([]);
		for (const width of [412, 320]) {
			await page.setViewportSize({ width, height: 800 });
			expect(await horizontalOverflow(page), `overflow at ${width}px`).toEqual([]);
		}
	});
}
