import { expect, test, type Page } from '@playwright/test';
import { stubStream } from './helpers';

// Linux Chromium ships middle-click autoscroll off; the flag turns on what Windows and ChromeOS have.
test.use({
	launchOptions: {
		args: ['--enable-features=MiddleClickAutoscroll'],
		// Headless hides scrollbars by default; the drag test needs a real track.
		ignoreDefaultArgs: ['--hide-scrollbars']
	},
	viewport: { width: 1280, height: 800 },
	isMobile: false,
	hasTouch: false
});

const history = Array.from({ length: 40 }, (_, i) => ({
	type: i % 2 ? 'assistant' : 'user',
	id: `h${i}`,
	at: 'x',
	text: `History message ${i} with enough words to wrap onto a second line on a phone screen.`,
	attachments: [],
	tools: [],
	files: []
}));

async function open(page: Page) {
	await stubStream(page.context());
	await page.context().route('**/api/**', (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === '/api/chat/history') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: history, before: null })
			});
		}
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	await page.goto('/');
	await expect(page.getByText('History message 39')).toBeVisible();
	return page.locator('main');
}

const top = (list: ReturnType<Page['locator']>) => list.evaluate((el) => el.scrollTop);

test('the wheel scrolls the chat', async ({ page }) => {
	const list = await open(page);
	const box = (await list.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, -500);
	await expect.poll(() => top(list)).toBeLessThan(-100);
});

test('middle-click autoscroll scrolls the chat', async ({ page }) => {
	const list = await open(page);
	const box = (await list.boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height * 0.75;
	await page.mouse.move(x, y);
	await page.mouse.down({ button: 'middle' });
	await page.mouse.up({ button: 'middle' });
	await page.mouse.move(x, y - 200, { steps: 10 });
	await expect.poll(() => top(list)).toBeLessThan(-100);
	await page.mouse.click(x, y - 200);
});

test('dragging the scrollbar scrolls the chat', async ({ page }) => {
	const list = await open(page);
	const box = (await list.boundingBox())!;
	const gutter = await list.evaluate((el) => el.offsetWidth - el.clientWidth);
	// The config turns real scrollbars on, so no gutter means the track itself went missing.
	expect(gutter).toBeGreaterThan(0);
	const x = box.x + box.width - gutter / 2;
	await page.mouse.move(x, box.y + box.height - 20);
	await page.mouse.down();
	await page.mouse.move(x, box.y + box.height / 2, { steps: 10 });
	await page.mouse.up();
	await expect.poll(() => top(list)).toBeLessThan(-100);
});
