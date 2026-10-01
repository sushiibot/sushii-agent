import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { axe, horizontalOverflow, smallTargets, stubStream } from './helpers';

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

/** Opens the phone drawer from the current screen's header. */
async function drawer(page: Page) {
	await page.getByRole('button', { name: /^Menu/ }).click();
	const menu = page.getByRole('dialog', { name: 'Menu' });
	await expect(menu).toBeVisible();
	return menu;
}

test('the app opens on the chat; the drawer lists only live slices, Settings last', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/');
	await expect(page).toHaveURL(/\/chat$/);
	const menu = await drawer(page);
	await expect(menu.getByRole('link')).toHaveText(['Chat', 'Inbox', 'Runs', 'History', 'Settings']);
	await expect(menu.getByRole('link', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
});

test('a slice the bot leaves off hides its entry', async ({ page, context }) => {
	await server(context, { live: ['home'] });
	await page.goto('/chat');
	await expect((await drawer(page)).getByRole('link')).toHaveText(['Chat', 'Inbox', 'Settings']);
});

test('the fixture override shows every section, with Chats under Inbox', async ({
	page,
	context
}) => {
	await server(context, { override: 'all' });
	await page.goto('/chat');
	const all = [
		'Chat',
		'Inbox',
		'Chats',
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

test('a screen whose slice is off sends you to the chat', async ({ page, context }) => {
	await server(context);
	await page.goto('/memory');
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('an unknown address sends you to the chat', async ({ page, context }) => {
	await server(context);
	await page.goto('/no-such-screen');
	await expect(page).toHaveURL(/\/chat$/);
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

for (const [path, api] of [
	['/chats', /^\/api\/(chats|threads)/],
	['/chats/x', /^\/api\/(chats|threads)/],
	['/connectors/add', /^\/api\/connectors/],
	['/skills/x/versions', /^\/api\/skills/],
	['/memory/writes/x', /^\/api\/memory/],
	['/memory/files/x', /^\/api\/memory/],
	['/schedules/x', /^\/api\/schedules/],
	['/browser', /^\/api\/browser/],
	['/briefing', /^\/api\/briefing/]
] as const) {
	test(`${path} with its feature off goes to the chat without asking the bot for it`, async ({
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

test('Chat from the drawer steps back to the chat underneath instead of stacking another', async ({
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
