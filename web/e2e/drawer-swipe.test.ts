import { expect, test, type Page } from '@playwright/test';
import { fixtureApp } from './helpers';

/** Real browser touches exercise scroll arbitration, rather than only invoking event callbacks. */
async function swipe(page: Page, from: [number, number], to: [number, number]) {
	const session = await page.context().newCDPSession(page);
	await session.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x: from[0], y: from[1] }]
	});
	for (let step = 1; step <= 8; step++) {
		await session.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [
				{ x: from[0] + ((to[0] - from[0]) * step) / 8, y: from[1] + ((to[1] - from[1]) * step) / 8 }
			]
		});
	}
	await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await session.detach();
}

test('an intentional edge swipe opens navigation and a left swipe closes it', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
	await swipe(page, [24, 400], [160, 400]);
	await expect(menu).toBeVisible();
	await swipe(page, [240, 780], [100, 780]);
	await expect(menu).toBeHidden();
	await page.getByRole('button', { name: /^Menu/ }).click();
	await expect(menu).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
});

test('vertical scrolling, short drags, center swipes, and composer touches do not open navigation', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
	for (const [from, to] of [
		[
			[24, 400],
			[40, 220]
		],
		[
			[24, 400],
			[64, 400]
		],
		[
			[120, 400],
			[260, 400]
		],
		[
			[24, 400],
			[160, 490]
		]
	] as [[number, number], [number, number]][]) {
		await swipe(page, from, to);
		await expect(menu).toBeHidden();
	}
	const input = await page.getByRole('textbox', { name: 'Message' }).boundingBox();
	expect(input).not.toBeNull();
	await swipe(page, [input!.x + 10, input!.y + 20], [input!.x + 150, input!.y + 20]);
	await expect(menu).toBeHidden();
});

test('open sheets and desktop widths keep their gestures', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/chat');
	await page.getByRole('button', { name: 'Chat commands', exact: true }).click();
	const commands = page.getByRole('dialog', { name: 'Chat commands' });
	await expect(commands).toBeVisible();
	await expect(commands).toHaveAttribute('data-state', 'open');
	expect(await commands.evaluate((element) => !!element.closest('[data-shell]'))).toBe(true);
	await swipe(page, [24, 400], [160, 400]);
	await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
	await page.keyboard.press('Escape');
	await page.setViewportSize({ width: 1280, height: 915 });
	await swipe(page, [24, 400], [160, 400]);
	await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeHidden();
});
