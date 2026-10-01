import { expect, test, type BrowserContext } from '@playwright/test';
import { axe, horizontalOverflow, smallTargets, stubStream } from './helpers';

async function server(context: BrowserContext) {
	await stubStream(context);
	await context.route('**/api/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/me') return route.fulfill({ json: { login: 'drk@example.com' } });
		if (path === '/api/chat/history') return route.fulfill({ json: { items: [], before: null } });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
}

const tabBar = (page: import('@playwright/test').Page) =>
	page
		.locator('nav[aria-label="Main"]')
		.filter({ has: page.getByRole('link', { name: 'More' }) })
		.last();

test('More lists Runs, History and Settings under the tab bar', async ({ page, context }) => {
	await server(context);
	await page.goto('/more');
	await expect(page.getByRole('heading', { name: 'More', level: 1 })).toBeVisible();
	const main = page.getByRole('main');
	await expect(main.getByRole('link')).toHaveText([
		/Runs.*Every chat turn/,
		/History.*notes by day/,
		/Settings.*Notifications/
	]);
	await expect(tabBar(page).getByRole('link', { name: 'More' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await main.getByRole('link', { name: /Settings/ }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await expect(page.getByRole('link', { name: 'More' })).toHaveCount(0);
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page).toHaveURL(/\/more$/);
});

test('switching tabs from More replaces its entry, so back lands on Home', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/');
	await tabBar(page).getByRole('link', { name: 'More' }).click();
	await expect(page).toHaveURL(/\/more$/);
	await tabBar(page).getByRole('link', { name: 'Chat' }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await page.goBack();
	await expect(page).toHaveURL(/\/$/);
});

test('Chat hides the tab bar and its back chevron returns Home', async ({ page, context }) => {
	await server(context);
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'More' })).toHaveCount(0);
	await page.getByRole('link', { name: 'Back to Home' }).click();
	await expect(page).toHaveURL(/\/$/);
	await page.goBack();
	await expect(page).not.toHaveURL(/\/chat$/);
});

test('the desktop sidebar lists the tabs with Runs and History under More', async ({
	page,
	context
}) => {
	await server(context);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/more');
	const sidebar = page.locator('nav[aria-label="Main"]').first();
	await expect(sidebar.getByRole('link')).toHaveText(['Home', 'Chat', 'More', 'Runs', 'History']);
	await expect(sidebar.getByRole('link', { name: 'More' })).toHaveAttribute('aria-current', 'page');
	for (const link of await sidebar.getByRole('link').all()) {
		expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(48);
	}
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`More passes axe, 48px targets and reflow in ${colorScheme}`, async ({ page, context }) => {
		await page.emulateMedia({ colorScheme });
		await server(context);
		await page.goto('/more');
		await expect(page.getByRole('link', { name: /Runs/ })).toBeVisible();
		expect(await axe(page)).toEqual([]);
		expect(await smallTargets(page)).toEqual([]);
		for (const width of [412, 320]) {
			await page.setViewportSize({ width, height: 800 });
			expect(await horizontalOverflow(page), `overflow at ${width}px`).toEqual([]);
		}
	});
}
