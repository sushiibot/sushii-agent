import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { axe, horizontalOverflow, smallTargets, stubStream, fixtureApp } from './helpers';

const LIVE_NAV = [
	'Chat',
	'Inbox',
	'Threads',
	'Runs',
	'History',
	'Memory',
	'Connectors',
	'Settings'
];

/** Live navigation never depends on /api/me; overrides enable only fixture previews. */
async function server(context: BrowserContext, opts: { override?: string; me?: 'hang' } = {}) {
	await stubStream(context);
	await context.addInitScript((override) => {
		if (override) localStorage.setItem('features:override', override);
	}, opts.override ?? '');
	await context.route('**/api/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/me') {
			if (opts.me === 'hang') return;
			return route.fulfill({ json: { login: 'drk@example.com' } });
		}
		if (path === '/api/chat/history') return route.fulfill({ json: { items: [], before: null } });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
}

/** Opens the phone drawer from the current screen's header. */
async function drawer(page: Page) {
	await page.getByRole('button', { name: /^Menu/ }).click();
	const menu = page.getByRole('dialog', { name: 'Menu' });
	await expect(menu).toBeVisible();
	return menu;
}

test('the app opens on chat and all live screens appear in the drawer by default', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/');
	await expect(page).toHaveURL(/\/chat$/);
	const menu = await drawer(page);
	await expect(menu.getByRole('link')).toHaveText(LIVE_NAV);
	await expect(menu.getByRole('link', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
});

test('the fixture override adds preview screens alongside every live screen', async ({
	page,
	context
}) => {
	await server(context, { override: 'all' });
	await page.goto('/chat');
	const all = [
		'Chat',
		'Inbox',
		'Threads',
		'Briefing',
		'Runs',
		'History',
		'Memory',
		'Skills',
		'Schedules',
		'Connectors',
		'Browser',
		'Settings'
	];
	await expect((await drawer(page)).getByRole('link')).toHaveText(all);
	await page.keyboard.press('Escape');
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(page.getByRole('button', { name: /^Menu/ })).toBeHidden();
	const sidebar = page.locator('nav[aria-label="Main"]').first();
	await expect(sidebar.getByRole('link')).toHaveText(all);
});

test('picking from the drawer closes it; back from there returns to the chat, then the drawer closes before leaving', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/chat');
	await (await drawer(page)).getByRole('link', { name: 'Runs' }).click();
	await expect(page).toHaveURL(/\/runs$/);
	await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
	await (await drawer(page)).getByRole('link', { name: 'History' }).click();
	await expect(page).toHaveURL(/\/history$/);
	await page.goBack();
	await expect(page).toHaveURL(/\/chat$/);
	await drawer(page);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
	await expect(page).toHaveURL(/\/chat$/);
});

test('an unknown address sends you to the chat', async ({ page, context }) => {
	await server(context);
	await page.goto('/no-such-screen');
	await expect(page).toHaveURL(/\/chat$/);
});

test('a live deep link renders while /api/me is unavailable', async ({ page, context }) => {
	await server(context, { me: 'hang' });
	await page.goto('/runs');
	await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
	await page.waitForTimeout(500);
	await expect(page).toHaveURL(/\/runs$/);
});

for (const [path, api] of [
	['/skills/x/versions', /^\/api\/skills/],
	['/schedules/x', /^\/api\/schedules/],
	['/browser', /^\/api\/browser/],
	['/briefing', /^\/api\/briefing/]
] as const) {
	test(`${path} without its fixture preview goes to chat without requesting preview data`, async ({
		page,
		context
	}) => {
		await server(context);
		const asked: string[] = [];
		page.on('request', (req) => {
			const p = new URL(req.url()).pathname;
			if (api.test(p)) asked.push(p);
		});
		await page.goto(path);
		await expect(page).toHaveURL(/\/chat$/);
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
		expect(asked).toEqual([]);
	});
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the open drawer passes axe, 48px targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await server(context, { override: 'all' });
		await page.goto('/chat');
		await drawer(page);
		expect(await axe(page)).toEqual([]);
		expect(await smallTargets(page)).toEqual([]);
		for (const width of [412, 320]) {
			await page.setViewportSize({ width, height: 800 });
			expect(await horizontalOverflow(page), `at ${width}px`).toEqual([]);
		}
	});
}

test('Main from the drawer steps back to the chat underneath instead of stacking another', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/chat');
	await (await drawer(page)).getByRole('link', { name: 'Inbox' }).click();
	await expect(page).toHaveURL(/\/inbox$/);
	await (await drawer(page)).getByRole('link', { name: 'Chat' }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await page.goForward();
	await expect(page).toHaveURL(/\/inbox$/);
	await page.goBack();
	await page.goBack();
	await expect(page).not.toHaveURL(/\/chat$/);
});

test('widening past the sidebar breakpoint closes an open drawer, so the page stays usable', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/chat');
	await drawer(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
	await page.locator('nav[aria-label="Main"]').first().getByRole('link', { name: 'Runs' }).click();
	await expect(page).toHaveURL(/\/runs$/);
});

test('Memory and thread deep links load without a fixture override', async ({ page, context }) => {
	await fixtureApp(context, { override: '' });
	await page.goto('/memory');
	await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
	await expect(page.getByRole('link', { name: /MEMORY.md/ })).toBeVisible();
	await page.goto('/chats/oct-trip');
	await expect(page.getByRole('heading', { name: 'October trip', level: 1 })).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});
