import { expect, test, type Page } from '@playwright/test';
import { fixtureApp } from './helpers';

async function swipe(page: Page, from: [number, number], to: [number, number]) {
	const session = await page.context().newCDPSession(page);
	try {
		await session.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x: from[0], y: from[1] }]
		});
		for (let step = 1; step <= 8; step++)
			await session.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [
					{
						x: from[0] + ((to[0] - from[0]) * step) / 8,
						y: from[1] + ((to[1] - from[1]) * step) / 8
					}
				]
			});
		await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	} finally {
		await session.detach();
	}
}
async function change(page: Page, direction: 'next' | 'previous') {
	const x = direction === 'next' ? 320 : 100;
	const y = await page.getByRole('main').evaluate((main, x) => {
		const box = main.getBoundingClientRect();
		for (let y = Math.min(box.bottom - 24, 780); y > box.top + 40; y -= 24) {
			const target = document.elementFromPoint(x, y);
			if (
				target &&
				main.contains(target) &&
				!target.closest('button,input,textarea,select,summary,[role="button"],[role="tab"]')
			)
				return y;
		}
		throw new Error('No non-control surface for section swipe');
	}, x);
	await swipe(page, [x, y], [direction === 'next' ? 100 : 320, y]);
}

for (const [path, first, second] of [
	['/runs/01K6B4D2F4H6K8M0P2R4T6V8X0', 'Overview', 'Timeline'],
	['/connectors/code-host', 'Tools', 'History']
])
	test(`touch swipes switch adjacent sections on ${path}`, async ({ page, context }) => {
		await fixtureApp(context);
		await page.goto(path);
		const selected = (name: string) =>
			expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
		await selected(first);
		await change(page, 'next');
		await selected(second);
		await change(page, 'previous');
		await selected(first);
		await change(page, 'previous');
		await selected(first);
	});

test('history day swipes between recaps and runs', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/history');
	await page.getByRole('main').getByRole('listitem').first().getByRole('link').click();
	await expect(page.getByRole('tab', { name: 'Recaps' })).toHaveAttribute('aria-selected', 'true');
	await change(page, 'next');
	await expect(page.getByRole('tab', { name: /^Runs/ })).toHaveAttribute('aria-selected', 'true');
	await change(page, 'previous');
	await expect(page.getByRole('tab', { name: 'Recaps' })).toHaveAttribute('aria-selected', 'true');
});

test('Runs filters swipe on link rows without opening the row', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/runs');
	await expect(page.getByRole('radio', { name: 'All', exact: true })).toBeChecked();
	const box = await page
		.getByRole('main')
		.getByRole('listitem')
		.first()
		.getByRole('link')
		.boundingBox();
	expect(box).not.toBeNull();
	await swipe(
		page,
		[box!.x + box!.width - 50, box!.y + box!.height / 2],
		[box!.x + 80, box!.y + box!.height / 2]
	);
	await expect(page.getByRole('radio', { name: 'Chat', exact: true })).toBeChecked();
	await expect(page).toHaveURL(/\/runs(?:\?|$)/);
	await change(page, 'previous');
	await expect(page.getByRole('radio', { name: 'All', exact: true })).toBeChecked();
});

test('memory swipes preserve search, taps and the drawer gesture', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/memory');
	const longTerm = page.getByRole('button', { name: 'Long-term', exact: true });
	const daily = page.getByRole('button', { name: 'Daily notes', exact: true });
	await expect(longTerm).toHaveAttribute('aria-pressed', 'true');
	await change(page, 'next');
	await expect(daily).toHaveAttribute('aria-pressed', 'true');
	const input = page.getByRole('searchbox', { name: 'Find a memory file' });
	await input.fill('2026');
	const box = await input.boundingBox();
	await swipe(
		page,
		[box!.x + 300, box!.y + box!.height / 2],
		[box!.x + 100, box!.y + box!.height / 2]
	);
	await expect(daily).toHaveAttribute('aria-pressed', 'true');
	await expect(input).toHaveValue('2026');
	await input.blur();
	await change(page, 'previous');
	await expect(longTerm).toHaveAttribute('aria-pressed', 'true');
	await expect(input).toHaveValue('2026');
	await daily.click();
	await expect(daily).toHaveAttribute('aria-pressed', 'true');
	await swipe(page, [24, 850], [160, 850]);
	await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeVisible();
	await expect(daily).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
});

test('vertical, diagonal, short drags and horizontal scrollers keep their behavior', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/runs/01K6B4D2F4H6K8M0P2R4T6V8X0');
	const overview = page.getByRole('tab', { name: 'Overview', exact: true });
	await expect(overview).toHaveAttribute('aria-selected', 'true');
	for (const [from, to] of [
		[
			[300, 600],
			[300, 450]
		],
		[
			[300, 600],
			[180, 480]
		],
		[
			[300, 600],
			[260, 600]
		]
	] as [[number, number], [number, number]][]) {
		await swipe(page, from, to);
		await expect(overview).toHaveAttribute('aria-selected', 'true');
	}
	await page.getByRole('tab', { name: 'Evidence' }).click();
	await page.getByRole('main').evaluate((main) => {
		const pre = document.createElement('pre');
		pre.style.cssText = 'width:100%;overflow-x:auto;height:100px';
		const code = document.createElement('code');
		code.style.cssText = 'display:block;width:1200px';
		code.textContent = 'wide evidence';
		pre.append(code);
		main.prepend(pre);
		main.scrollTop = 0;
	});
	await swipe(page, [300, 100], [100, 100]);
	await expect(page.getByRole('tab', { name: 'Evidence' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	expect(await page.locator('main > pre').evaluate((pre) => pre.scrollLeft)).toBeGreaterThan(0);
	await page.setViewportSize({ width: 1280, height: 915 });
	await change(page, 'next');
	await expect(page.getByRole('tab', { name: 'Evidence' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
});
