import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { axe, horizontalOverflow, push, smallTargets, stubStream } from './helpers';

const SHOTS = 'proto-screenshots/m1/long-press';

type Post = { clientId: string; text: string };

const item = (type: 'user' | 'assistant', id: string, text: string) => ({
	type,
	id,
	at: 'x',
	text,
	attachments: [],
	tools: [],
	files: [],
	verified: true
});

const filler = (n: number) =>
	Array.from({ length: n }, (_, i) =>
		item(
			i % 2 ? 'assistant' : 'user',
			`h${i}`,
			`History message ${i} with enough words to wrap onto a second line on a phone screen.`
		)
	);

const REPLY =
	'Booked **Eastside Auto** for _Saturday 09:00_.\n\n- Confirmation `BK-5520`\n- [Directions](https://example.com/map)';
const REPLY_PLAIN = 'Booked Eastside Auto for Saturday 09:00.\n\nConfirmation BK-5520\nDirections';

async function chatServer(context: BrowserContext, history: unknown[]) {
	const opts = { messageStatus: 202 };
	const posts: Post[] = [];
	await stubStream(context);
	await context.route('https://example.com/**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Map</title>' })
	);
	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (path === '/api/me') return json({ login: 'drk@example.com' });
		if (path === '/api/chat/history') return json({ items: history, before: null });
		if (path === '/api/chat/messages') {
			posts.push(JSON.parse(req.postData() ?? '{}'));
			if (opts.messageStatus !== 202) return json({ error: 'bad' }, opts.messageStatus);
			return json({ seq: 1 }, 202);
		}
		if (path === '/api/chat/seen') return route.fulfill({ status: 204 });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	return { opts, posts };
}

async function open(page: Page) {
	await page.goto('/');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
}

async function send(page: Page, text: string) {
	await page.getByRole('textbox', { name: 'Message' }).fill(text);
	await page.getByRole('button', { name: 'Send message' }).click();
}

const bubble = (page: Page, text: string) =>
	page.locator('[data-message-id]').filter({ hasText: text });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Message actions' });
/** Message actions buttons a sighted user can see: they stay in the tab order but transparent. */
const shownDots = (page: Page) =>
	page.$$eval(
		'[data-message-actions]',
		(els) => els.filter((e) => getComputedStyle(e).opacity !== '0').length
	);
const article = (page: Page, text: string) => bubble(page, text).locator('[data-message-focus]');

/** The keyboard path: focus the message itself, then Enter. */
async function openMenu(page: Page, text: string) {
	// A keypress first, so the focus counts as keyboard focus (:focus-visible), as a Tab would.
	await page.keyboard.press('Shift');
	await article(page, text).focus();
	await page.keyboard.press('Enter');
	await expect(sheet(page)).toBeVisible();
}

async function touch(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	const at = async (target: Locator) => {
		const box = (await target.boundingBox())!;
		return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 12) };
	};
	return {
		async hold(target: Locator, ms = 700) {
			const p = await at(target);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
			await page.waitForTimeout(ms);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		},
		async tap(target: Locator) {
			const p = await at(target);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
			await page.waitForTimeout(60);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		},
		async drag(target: Locator, dy: number) {
			const p = await at(target);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
			for (let i = 1; i <= 10; i++) {
				await cdp.send('Input.dispatchTouchEvent', {
					type: 'touchMove',
					touchPoints: [{ x: p.x, y: p.y + (dy * i) / 10 }]
				});
			}
			await page.waitForTimeout(700);
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		}
	};
}

test('holding a bubble opens one sheet, and a scroll gesture does not', async ({
	page,
	context
}) => {
	await chatServer(context, [...filler(12), item('assistant', 'r1', REPLY)]);
	await open(page);
	const t = await touch(page);

	const list = page.locator('main');
	const before = await list.evaluate((el) => el.scrollTop);
	await t.drag(bubble(page, 'History message 11'), 300);
	expect(await list.evaluate((el) => el.scrollTop)).not.toBe(before);
	await expect(sheet(page)).toHaveCount(0);

	const reply = bubble(page, 'Booked Eastside').locator('[data-message-text]');
	await reply.scrollIntoViewIfNeeded();
	// Let the drag's fling finish: any scroll during a hold cancels it, by design.
	let last = NaN;
	await expect
		.poll(async () => {
			const now = await list.evaluate((el) => el.scrollTop);
			const settled = now === last;
			last = now;
			return settled;
		})
		.toBe(true);
	await t.hold(reply);
	await expect(sheet(page)).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(1);
	await expect(sheet(page).getByRole('button', { name: 'Copy text' })).toBeFocused();
	await expect(article(page, 'Booked Eastside')).toHaveClass(/ring-2/);
	// The hold's own click never reaches the link it started on.
	expect(context.pages()).toHaveLength(1);
});

test('a tap on a link inside a bubble still opens it', async ({ page, context }) => {
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	const popup = context.waitForEvent('page');
	await page.getByRole('link', { name: 'Directions' }).tap();
	expect((await popup).url()).toBe('https://example.com/map');
	await expect(sheet(page)).toHaveCount(0);
});

test('Copy text puts the rendered text on the clipboard and announces it', async ({
	page,
	context
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	await bubble(page, 'Booked Eastside').locator('[data-message-text]').click({ button: 'right' });
	await sheet(page).getByRole('button', { name: 'Copy text' }).click();
	await expect(sheet(page)).toHaveCount(0);
	await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeAttached();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPLY_PLAIN);
});

test('the first tap on the sheet right after a hold is not swallowed', async ({
	page,
	context
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
	const t = await touch(page);
	await t.hold(bubble(page, 'Booked Eastside').locator('[data-message-text]'));
	await expect(sheet(page)).toBeVisible();
	await page.waitForTimeout(100);
	await t.tap(sheet(page).getByRole('button', { name: 'Copy text' }));
	await expect(sheet(page)).toHaveCount(0);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPLY_PLAIN);
});

test('Retry and Delete appear only on your own unsent messages', async ({ page, context }) => {
	const { opts, posts } = await chatServer(context, [
		item('user', 'u1', 'Book the car service'),
		item('assistant', 'r1', REPLY)
	]);
	await open(page);
	const retry = sheet(page).getByRole('button', { name: 'Retry send' });
	const del = sheet(page).getByRole('button', { name: 'Delete message' });

	for (const text of ['Book the car service', 'Booked Eastside']) {
		await openMenu(page, text);
		await expect(sheet(page)).toBeVisible();
		await expect(retry).toHaveCount(0);
		await expect(del).toHaveCount(0);
		await expect(sheet(page).getByRole('button', { name: /approve|allow|run/i })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toHaveCount(0);
	}

	opts.messageStatus = 400;
	await send(page, 'This one fails');
	await expect(bubble(page, 'This one fails')).toContainText('Failed');
	await openMenu(page, 'This one fails');
	await expect(retry).toBeVisible();
	await expect(del).toBeVisible();
	opts.messageStatus = 202;
	await retry.click();
	await expect.poll(() => posts.length).toBe(2);
	expect(posts[1].clientId).toBe(posts[0].clientId);

	opts.messageStatus = 400;
	await send(page, 'Delete me');
	await expect(bubble(page, 'Delete me')).toContainText('Failed');
	await openMenu(page, 'Delete me');
	await del.click();
	await expect(bubble(page, 'Delete me')).toHaveCount(0);
	await expect(sheet(page)).toHaveCount(0);
});

test('the sheet works from the keyboard, traps focus, and Escape and Back close it', async ({
	page,
	context
}) => {
	await chatServer(context, [
		item('user', 'u1', 'Book the car service'),
		item('assistant', 'r1', REPLY)
	]);
	await open(page);
	expect(await shownDots(page)).toBe(0);

	const trigger = article(page, 'Booked Eastside');
	await page.keyboard.press('Shift');
	await trigger.focus();
	await expect(trigger).toHaveAccessibleName('Agent message');
	// Focus reveals the button, and Tab reaches it.
	await expect(trigger.getByRole('button', { name: 'Message actions' })).toHaveCSS('opacity', '1');
	expect(await shownDots(page)).toBe(1);
	await page.keyboard.press('Enter');
	const copy = sheet(page).getByRole('button', { name: 'Copy text' });
	await expect(copy).toBeFocused();
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('Tab');
		expect(await sheet(page).evaluate((d) => d.contains(document.activeElement))).toBe(true);
	}
	await page.keyboard.press('Escape');
	await expect(sheet(page)).toHaveCount(0);
	await expect(trigger).toBeFocused();

	await page.keyboard.press('Shift+F10');
	await expect(sheet(page)).toBeVisible();
	await page.goBack();
	await expect(sheet(page)).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

	await page.keyboard.press('Shift');
	await article(page, 'Book the car service').focus();
	await page.keyboard.press('Tab');
	const mine = article(page, 'Book the car service').getByRole('button', {
		name: 'Message actions'
	});
	await expect(mine).toBeFocused();
	await expect(mine).toHaveCSS('opacity', '1');
	await page.keyboard.press('Enter');
	await expect(sheet(page)).toBeVisible();
	await expect(sheet(page)).toContainText('Book the car service');
});

test('Select text makes the bubble selectable and selects its text', async ({ page, context }) => {
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	const text = bubble(page, 'Booked Eastside').locator('[data-message-text]');
	await expect(text).toHaveCSS('user-select', 'none');
	await text.click({ button: 'right' });
	await sheet(page).getByRole('button', { name: 'Select text' }).click();
	await expect(sheet(page)).toHaveCount(0);
	await expect(text).not.toHaveCSS('user-select', 'none');
	await expect
		.poll(() => page.evaluate(() => document.getSelection()?.toString()))
		.toContain('Booked Eastside Auto');
	await page.getByRole('textbox', { name: 'Message' }).click();
	await expect(text).toHaveCSS('user-select', 'none');
});

test('the sheet never opens inside the approval tray', async ({ page, context }) => {
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	await push(
		page,
		'approval',
		{
			nonce: 'n1',
			view: {
				tool: 'send_email',
				agentId: 'main',
				agentName: 'Main',
				fields: [{ key: 'to', value: 'dana@example.com', kind: 'single', max: 200 }]
			}
		},
		1
	);
	const tray = page.locator('[data-surface="approval"]');
	await expect(tray).toBeVisible();
	await tray.click({ button: 'right' });
	await expect(sheet(page)).toHaveCount(0);
	await bubble(page, 'Booked Eastside').locator('[data-message-text]').click({ button: 'right' });
	await expect(sheet(page)).toBeVisible();
	await expect(tray.getByRole('dialog')).toHaveCount(0);
	await expect(sheet(page).getByRole('button', { name: /approve|allow|run/i })).toHaveCount(0);
});

test('right-click opens the same sheet at desktop width', async ({ browser }) => {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		isMobile: false,
		hasTouch: false
	});
	const page = await context.newPage();
	await chatServer(context, [item('assistant', 'r1', REPLY)]);
	await open(page);
	await bubble(page, 'Booked Eastside').locator('[data-message-text]').click({ button: 'right' });
	await expect(sheet(page)).toBeVisible();
	await expect(sheet(page).getByRole('button', { name: 'Copy text' })).toBeInViewport();
	await context.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the sheet passes axe, 48px targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		const { opts } = await chatServer(context, [...filler(4), item('assistant', 'r1', REPLY)]);
		await open(page);
		opts.messageStatus = 400;
		await send(page, 'Add the confirmation to my calendar.');
		await expect(bubble(page, 'Add the confirmation')).toContainText('Failed');
		expect(await axe(page)).toEqual([]);
		expect(await smallTargets(page)).toEqual([]);
		expect(await shownDots(page)).toBe(0);
		for (const width of [412, 320]) {
			await page.setViewportSize({ width, height: width === 412 ? 915 : 640 });
			await page.screenshot({ path: `${SHOTS}/list-${width}-${colorScheme}.png` });
		}
		await page.setViewportSize({ width: 412, height: 915 });

		await page.keyboard.press('Shift');
		await article(page, 'Booked Eastside').focus();
		expect(await axe(page)).toEqual([]);
		expect(await smallTargets(page)).toEqual([]);
		await page.screenshot({ path: `${SHOTS}/focused-412-${colorScheme}.png` });

		for (const [held, name] of [
			['Booked Eastside', 'reply'],
			['Add the confirmation', 'failed']
		] as const) {
			await openMenu(page, held);
			await expect(sheet(page)).toBeVisible();
			expect(await axe(page)).toEqual([]);
			expect(await smallTargets(page)).toEqual([]);
			for (const width of [412, 320]) {
				await page.setViewportSize({ width, height: width === 412 ? 915 : 640 });
				expect(await horizontalOverflow(page), `overflow at ${width}px`).toEqual([]);
				await page.screenshot({ path: `${SHOTS}/${name}-${width}-${colorScheme}.png` });
			}
			await page.setViewportSize({ width: 412, height: 915 });
			await page.keyboard.press('Escape');
			await expect(sheet(page)).toHaveCount(0);
		}
	});
}
