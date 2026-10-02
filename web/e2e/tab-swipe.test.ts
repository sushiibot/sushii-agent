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
	const gesture = await page.locator('[data-tab-pager]').evaluate((main, direction) => {
		const box = main.getBoundingClientRect();
		const x = box.left + box.width * (direction === 'next' ? 0.8 : 0.2);
		const to = box.left + box.width * (direction === 'next' ? 0.2 : 0.8);
		for (let y = Math.min(box.bottom - 24, 780); y > box.top + 40; y -= 24) {
			const target = document.elementFromPoint(x, y);
			if (
				target &&
				main.contains(target) &&
				!target.closest('button,input,textarea,select,summary,[role="button"],[role="tab"]')
			)
				return { x, y, to };
		}
		throw new Error('No non-control surface for section swipe');
	}, direction);
	await swipe(page, [gesture.x, gesture.y], [gesture.to, gesture.y]);
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
	await expect(page.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	const box = await page
		.getByRole('tabpanel')
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
	await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page).toHaveURL(/\/runs(?:\?|$)/);
	await change(page, 'previous');
	await expect(page.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
});

test('memory swipes preserve search, taps and the drawer gesture', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/memory');
	await expect(page.getByRole('heading', { name: 'Long-term files' })).toBeVisible();
	const longTerm = page.getByRole('tab', { name: 'Long-term', exact: true });
	const daily = page.getByRole('tab', { name: 'Daily notes', exact: true });
	await expect(longTerm).toHaveAttribute('aria-selected', 'true');
	await change(page, 'next');
	await expect(daily).toHaveAttribute('aria-selected', 'true');
	const input = page.getByRole('searchbox', { name: 'Search memory' });
	await input.fill('2026');
	const box = await input.boundingBox();
	await swipe(
		page,
		[box!.x + 300, box!.y + box!.height / 2],
		[box!.x + 100, box!.y + box!.height / 2]
	);
	await expect(daily).toHaveAttribute('aria-selected', 'true');
	await expect(input).toHaveValue('2026');
	await input.blur();
	await change(page, 'previous');
	await expect(longTerm).toHaveAttribute('aria-selected', 'true');
	await expect(input).toHaveValue('2026');
	await daily.click();
	await expect(daily).toHaveAttribute('aria-selected', 'true');
	await swipe(page, [24, 850], [160, 850]);
	await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeVisible();
	await expect(daily).toHaveAttribute('aria-selected', 'true');
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
	await expectSettled(page, 'Evidence');
	await page.getByRole('main').evaluate((main) => {
		const pre = document.createElement('pre');
		pre.style.cssText = 'width:100%;overflow-x:auto;height:100px';
		const code = document.createElement('code');
		code.style.cssText = 'display:block;width:1200px';
		code.textContent = 'wide evidence';
		pre.append(code);
		const panel = main.querySelector('[role=tabpanel]:not([aria-hidden=true])')!;
		panel.prepend(pre);
		panel.scrollTop = 0;
	});
	const preBox = await page.locator('[role=tabpanel] > pre').boundingBox();
	await swipe(page, [preBox!.x + 300, preBox!.y + 50], [preBox!.x + 100, preBox!.y + 50]);
	await expect(page.getByRole('tab', { name: 'Evidence' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect
		.poll(() => page.locator('[role=tabpanel] > pre').evaluate((pre) => pre.scrollLeft))
		.toBeGreaterThan(0);
	await page.setViewportSize({ width: 1280, height: 915 });
	await change(page, 'next');
	await expect(page.getByRole('tab', { name: 'Evidence' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
});

const EXPENSES = '/runs/01K6B3A1C3E5G7J9M1P3R5T7V9';
const panel = (page: Page, name: string) =>
	page.getByRole('tabpanel', { name, exact: true, includeHidden: true });

async function heldDrag(page: Page, distance: number) {
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	const session = await page.context().newCDPSession(page);
	const box = await page.locator('[data-tab-pager]').boundingBox();
	expect(box).not.toBeNull();
	const x = box!.x + box!.width * 0.75;
	const y = box!.y + Math.min(box!.height - 24, 230);
	await session.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x, y }]
	});
	for (let step = 1; step <= 8; step++)
		await session.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: x - (distance * step) / 8, y }]
		});
	return {
		width: box!.width,
		moveTo: async (nextDistance: number) => {
			for (let step = 1; step <= 8; step++)
				await session.send('Input.dispatchTouchEvent', {
					type: 'touchMove',
					touchPoints: [{ x: x - distance - ((nextDistance - distance) * step) / 8, y }]
				});
			distance = nextDistance;
		},
		finish: async () => {
			await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await session.detach();
		}
	};
}

async function indicatorBox(page: Page) {
	return page.locator('[data-tab-indicator]').evaluate((el) => {
		const { x, width } = el.getBoundingClientRect();
		return { x, width };
	});
}

async function expectSettled(page: Page, name: string) {
	const tab = page.getByRole('tab', { name, exact: true });
	await expect(tab).toHaveAttribute('aria-selected', 'true');
	await expect
		.poll(async () => {
			const pane = await panel(page, name).boundingBox();
			const viewport = await page.locator('[data-tab-pager]').boundingBox();
			return Math.abs(pane!.x - viewport!.x);
		})
		.toBeLessThan(1);
	await expect
		.poll(async () => {
			const indicator = await indicatorBox(page);
			const target = await tab.boundingBox();
			return Math.abs(indicator.x - target!.x);
		})
		.toBeLessThan(1);
}

test('held touch tracks the finger, reveals the adjacent pane and moves the underline proportionally', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto(EXPENSES);
	await expectSettled(page, 'Overview');
	const start = await panel(page, 'Overview').boundingBox();
	const first = await page.getByRole('tab', { name: 'Overview', exact: true }).boundingBox();
	const second = await page.getByRole('tab', { name: 'Timeline', exact: true }).boundingBox();
	const drag = await heldDrag(page, 130);
	try {
		await expect
			.poll(async () => start!.x - (await panel(page, 'Overview').boundingBox())!.x)
			.toBeGreaterThan(115);
		const current = await panel(page, 'Overview').boundingBox();
		expect(start!.x - current!.x).toBeLessThan(145);
		const neighbor = await panel(page, 'Timeline').boundingBox();
		expect(neighbor!.x).toBeLessThan(start!.x + drag.width);
		expect(neighbor!.x + neighbor!.width).toBeGreaterThan(start!.x);
		const underline = await indicatorBox(page);
		const fraction = (start!.x - current!.x) / drag.width;
		expect(Math.abs(underline.x - (first!.x + (second!.x - first!.x) * fraction))).toBeLessThan(3);
		expect(
			Math.abs(underline.width - (first!.width + (second!.width - first!.width) * fraction))
		).toBeLessThan(3);
		// Geometry assertions hold the finger long enough to lose fling velocity. Move past
		// the midpoint before releasing so selection depends on distance, not runner speed.
		await drag.moveTo(drag.width * 0.6);
	} finally {
		await drag.finish();
	}
	await expectSettled(page, 'Timeline');
});

test('short slow drags settle back without changing the selected tab', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto(EXPENSES);
	await expectSettled(page, 'Overview');
	const drag = await heldDrag(page, 35);
	// Holding the last move removes fling velocity: distance alone must not commit this drag.
	await page.waitForTimeout(180);
	await drag.finish();
	await expectSettled(page, 'Overview');
});

test('tapping a tab animates both content and underline to the same destination', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto(EXPENSES);
	await expectSettled(page, 'Overview');
	const initial = await indicatorBox(page);
	const target = await page.getByRole('tab', { name: 'Timeline', exact: true }).boundingBox();
	// Observe inside the page so round trips cannot miss a short animation.
	const midway = await page
		.getByRole('tab', { name: 'Timeline', exact: true })
		.evaluate(async (tab) => {
			(tab as HTMLButtonElement).click();
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
			const indicator = document.querySelector('[data-tab-indicator]')!.getBoundingClientRect();
			const pane = document.querySelector('[data-tab-panel="overview"]')!.getBoundingClientRect();
			const viewport = document.querySelector('[data-tab-pager]')!.getBoundingClientRect();
			return { x: indicator.x, paneX: pane.x, viewportX: viewport.x, width: viewport.width };
		});
	expect(midway.x).toBeGreaterThan(initial.x);
	expect(midway.x).toBeLessThan(target!.x);
	expect(midway.paneX).toBeLessThan(midway.viewportX);
	expect(midway.paneX).toBeGreaterThan(midway.viewportX - midway.width);
	await expectSettled(page, 'Timeline');
});

test('panes retain separate vertical positions and expanded timeline steps', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto(EXPENSES);
	await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
	await expectSettled(page, 'Timeline');
	const step = panel(page, 'Timeline').getByRole('button', {
		name: /^Succeeded bash .*python summarize/
	});
	await step.click();
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	await panel(page, 'Timeline').evaluate((el) => {
		const spacer = document.createElement('div');
		spacer.style.height = '1600px';
		el.append(spacer);
		el.scrollTop = 160;
	});
	expect(await panel(page, 'Timeline').evaluate((el) => el.scrollTop)).toBe(160);
	await page.getByRole('tab', { name: 'Evidence', exact: true }).click();
	await expectSettled(page, 'Evidence');
	expect(await panel(page, 'Evidence').evaluate((el) => el.scrollTop)).toBe(0);
	await panel(page, 'Evidence').evaluate((el) => {
		const spacer = document.createElement('div');
		spacer.style.height = '1600px';
		el.append(spacer);
		el.scrollTop = 90;
	});
	await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
	await expectSettled(page, 'Timeline');
	expect(await panel(page, 'Timeline').evaluate((el) => el.scrollTop)).toBe(160);
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	await page.getByRole('tab', { name: 'Evidence', exact: true }).click();
	await expectSettled(page, 'Evidence');
	expect(await panel(page, 'Evidence').evaluate((el) => el.scrollTop)).toBe(90);
});

test('pager tabs support arrow, Home and End keys and reduced motion settles immediately', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(EXPENSES);
	const overview = page.getByRole('tab', { name: 'Overview', exact: true });
	const timeline = page.getByRole('tab', { name: 'Timeline', exact: true });
	await overview.focus();
	await page.keyboard.press('ArrowRight');
	await expect(timeline).toBeFocused();
	await expectSettled(page, 'Timeline');
	await page.keyboard.press('End');
	await expect(page.getByRole('tab', { name: 'Related', exact: true })).toBeFocused();
	await expectSettled(page, 'Related');
	await page.keyboard.press('Home');
	await expect(overview).toBeFocused();
	await expectSettled(page, 'Overview');
	const position = await timeline.evaluate(async (tab) => {
		(tab as HTMLButtonElement).click();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const pane = document.querySelector('[data-tab-panel="timeline"]')!.getBoundingClientRect();
		const viewport = document.querySelector('[data-tab-pager]')!.getBoundingClientRect();
		return Math.abs(pane.x - viewport.x);
	});
	expect(position).toBeLessThan(1);
});

test('returning to Runs keeps cached rows stationary during a delayed refresh', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	let delayAll = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await context.route('**/api/runs*', async (route) => {
		const url = new URL(route.request().url());
		if (delayAll && url.pathname === '/api/runs' && !url.searchParams.has('kind')) await gate;
		await route.fallback();
	});
	try {
		await page.goto('/runs');
		await expectSettled(page, 'All');
		const all = page.locator('[data-tab-panel="all"]');
		const first = all.getByRole('link').first();
		await expect(first).toBeVisible();
		const before = await first.boundingBox();
		const chatReady = page.waitForResponse((response) => {
			const url = new URL(response.url());
			return url.pathname === '/api/runs' && url.searchParams.get('kind') === 'chat';
		});
		await page.getByRole('tab', { name: 'Chat', exact: true }).click();
		await chatReady;
		await expectSettled(page, 'Chat');
		delayAll = true;
		await page.getByRole('tab', { name: 'All', exact: true }).click();
		await expectSettled(page, 'All');
		await expect
			.poll(async () => Math.abs((await first.boundingBox())!.y - before!.y))
			.toBeLessThan(1);
		const refreshed = page.waitForResponse(
			(response) => new URL(response.url()).pathname === '/api/runs'
		);
		release();
		await refreshed;
		await expect
			.poll(async () => Math.abs((await first.boundingBox())!.y - before!.y))
			.toBeLessThan(1);
		expect(await page.getByRole('main').evaluate((main) => main.scrollTop)).toBe(0);
	} finally {
		release();
	}
});

test('a swipe does not fetch a Runs filter before its pane has arrived', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	const filters: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.pathname === '/api/runs') filters.push(url.searchParams.get('kind') ?? 'all');
	});
	await page.goto('/runs');
	await expectSettled(page, 'All');
	await expect(page.getByRole('tabpanel').getByRole('link').first()).toBeVisible();
	const drag = await heldDrag(page, 230);
	await page.waitForTimeout(150);
	expect(filters).toEqual(['all']);
	await drag.finish();
	await expectSettled(page, 'Chat');
	await expect.poll(() => filters).toEqual(['all', 'chat']);
});

test('MCP tabs keep the same viewport and a single vertical scroll owner', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/connectors/code-host');
	await expectSettled(page, 'Tools');
	await expect(page.getByRole('button', { name: 'Save tracking snapshot' })).toBeVisible();
	const before = await page.locator('[data-tab-pager]').boundingBox();
	await page.getByRole('tab', { name: 'History', exact: true }).click();
	await expectSettled(page, 'History');
	const after = await page.locator('[data-tab-pager]').boundingBox();
	expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
	expect(Math.abs(after!.height - before!.height)).toBeLessThan(1);
	expect(await page.getByRole('main').evaluate((main) => getComputedStyle(main).overflowY)).toBe(
		'hidden'
	);
});

test('refreshing run data during a held swipe keeps the pager mounted and stationary', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	let refreshing = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await context.route('**/api/runs/*', async (route) => {
		if (refreshing) await gate;
		await route.fallback();
	});
	await page.goto(EXPENSES);
	await expectSettled(page, 'Overview');
	const drag = await heldDrag(page, 130);
	try {
		await expect
			.poll(async () => {
				const pane = await panel(page, 'Overview').boundingBox();
				const viewport = await page.locator('[data-tab-pager]').boundingBox();
				return Math.abs(viewport!.x - pane!.x - 130);
			})
			.toBeLessThan(1);
		const heldX = await panel(page, 'Overview').evaluate((el) => el.getBoundingClientRect().x);
		refreshing = true;
		const response = page.waitForResponse((response) =>
			new URL(response.url()).pathname.startsWith('/api/runs/')
		);
		const request = page.waitForRequest((request) =>
			new URL(request.url()).pathname.startsWith('/api/runs/')
		);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await request;
		await expect(page.locator('[data-tab-pager]')).toHaveCount(1);
		await expect
			.poll(() =>
				panel(page, 'Overview').evaluate(
					(el, previousX) => Math.abs(el.getBoundingClientRect().x - previousX),
					heldX
				)
			)
			.toBeLessThan(1);
		release();
		await response;
		await expect
			.poll(() =>
				panel(page, 'Overview').evaluate(
					(el, previousX) => Math.abs(el.getBoundingClientRect().x - previousX),
					heldX
				)
			)
			.toBeLessThan(1);
	} finally {
		release();
		await drag.finish();
	}
});

test('narrow Runs tabs keep full labels and keyboard selection reveals the last tab', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.setViewportSize({ width: 320, height: 915 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/runs');
	await expectSettled(page, 'All');
	const tabs = page.getByRole('tablist', { name: 'Type of run' });
	expect(
		await tabs
			.getByRole('tab')
			.evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth))
	).toBe(true);
	await tabs.getByRole('tab', { name: 'All', exact: true }).focus();
	await page.keyboard.press('End');
	await expectSettled(page, 'Agents');
	const last = await tabs.getByRole('tab', { name: 'Agents', exact: true }).boundingBox();
	expect(last!.x).toBeGreaterThanOrEqual(0);
	expect(last!.x + last!.width).toBeLessThanOrEqual(320.5);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		)
	).toBe(true);
});

for (const [path, first] of [
	['/runs', 'All'],
	[EXPENSES, 'Overview'],
	['/history', 'Recaps'],
	['/memory', 'Long-term'],
	['/connectors/code-host', 'Tools']
]) {
	for (const width of [320, 412]) {
		test(`${path} keeps full-width aligned panels after interruption at ${width}px`, async ({
			page,
			context
		}) => {
			await fixtureApp(context);
			await page.setViewportSize({ width, height: 915 });
			await page.goto(path);
			if (path === '/history') {
				await page.getByRole('main').getByRole('listitem').first().getByRole('link').click();
			}
			if (path === '/memory') {
				await expect(
					page.getByRole('heading', { name: 'Long-term files', exact: true })
				).toBeVisible();
			}
			await expectSettled(page, first);
			await expect(page.locator('[data-tabbed-screen]')).toHaveCount(1);
			const gutters = await panel(page, first)
				.locator('[data-tab-content]')
				.evaluate((content) => {
					const style = getComputedStyle(content);
					return [style.paddingLeft, style.paddingRight, style.paddingTop];
				});
			expect(gutters).toEqual(['16px', '16px', '16px']);
			const drag = await heldDrag(page, 130);
			try {
				await expect
					.poll(async () => {
						const pane = await panel(page, first).boundingBox();
						const viewport = await page.locator('[data-tab-pager]').boundingBox();
						return viewport!.x - pane!.x;
					})
					.toBeGreaterThan(115);
				await page.evaluate(() => window.dispatchEvent(new Event('blur')));
				await expectSettled(page, first);
			} finally {
				await drag.finish();
			}
			await expectSettled(page, first);
			const viewport = await page.locator('[data-tab-pager]').boundingBox();
			const pane = await panel(page, first).boundingBox();
			expect(viewport!.x).toBeLessThan(1);
			expect(viewport!.width).toBe(width);
			expect(Math.abs(pane!.x - viewport!.x)).toBeLessThan(1);
			expect(pane!.width).toBe(width);
			expect(
				await page.getByRole('main').evaluate((main) => getComputedStyle(main).overflowY)
			).toBe('hidden');
			expect(await page.getByRole('main').evaluate((main) => main.scrollLeft)).toBe(0);
		});
	}
}
