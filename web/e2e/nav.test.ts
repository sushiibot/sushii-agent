import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { stubStream } from './helpers';

const LIVE = ['runs', 'history', 'home', 'alerts'];

/** The app with the bot listing `live`; `override` is the device's fixture override. */
async function server(
	context: BrowserContext,
	opts: { live?: string[]; override?: string; me?: 'hang' } = {}
) {
	await stubStream(context);
	await context.addInitScript((override) => {
		if (override) localStorage.setItem('features:override', override);
	}, opts.override ?? '');
	await context.route('**/api/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/me') {
			if (opts.me === 'hang') return;
			return route.fulfill({ json: { login: 'drk@example.com', features: opts.live ?? LIVE } });
		}
		if (path === '/api/chat/history') return route.fulfill({ json: { items: [], before: null } });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
}

const tabBar = (page: Page) =>
	page
		.locator('nav[aria-label="Main"]')
		.filter({ has: page.getByRole('link', { name: 'More' }) })
		.last();

test('only live slices show: one Chat tab, and More lists what the bot turned on', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/more');
	await expect(tabBar(page).getByRole('link')).toHaveText(['Home', 'Chat', 'More']);
	await expect(page.getByRole('main').getByRole('link')).toHaveText([
		/^\s*Runs/,
		/^\s*History/,
		/^\s*Settings/
	]);
});

test('a slice the bot leaves off hides its entry', async ({ page, context }) => {
	await server(context, { live: ['home'] });
	await page.goto('/more');
	await expect(page.getByRole('main').getByRole('link')).toHaveText([/^\s*Settings/]);
});

test('the fixture override shows every section, and Chat becomes Chats', async ({
	page,
	context
}) => {
	await server(context, { override: 'all' });
	await page.goto('/more');
	await expect(tabBar(page).getByRole('link')).toHaveText(['Home', 'Chats', 'More']);
	await expect(page.getByRole('main').getByRole('link')).toHaveText([
		/^\s*Briefing/,
		/^\s*Runs/,
		/^\s*History/,
		/^\s*Memory/,
		/^\s*Skills/,
		/^\s*Schedules/,
		/^\s*Connectors/,
		/^\s*Browser/,
		/^\s*Settings/
	]);
	await page.setViewportSize({ width: 1280, height: 800 });
	const sidebar = page.locator('nav[aria-label="Main"]').first();
	await expect(sidebar.getByRole('link')).toHaveText([
		'Home',
		'Chats',
		'More',
		'Briefing',
		'Runs',
		'History',
		'Memory',
		'Skills',
		'Schedules',
		'Connectors',
		'Browser'
	]);
});

test('a screen whose slice is off sends you Home', async ({ page, context }) => {
	await server(context);
	await page.goto('/memory');
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
});

test('an unknown address sends you Home', async ({ page, context }) => {
	await server(context);
	await page.goto('/no-such-screen');
	await expect(page).toHaveURL(/\/$/);
});

test('a deep link waits for /api/me before deciding, so it never bounces early', async ({
	page,
	context
}) => {
	await server(context, { me: 'hang' });
	await page.goto('/runs');
	await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
	await page.waitForTimeout(500);
	await expect(page).toHaveURL(/\/runs$/);
});
