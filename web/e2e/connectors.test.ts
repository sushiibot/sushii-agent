import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test('connector tool changes are informational and the tracking snapshot is optional', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/connectors');
	await expect(page.getByRole('region', { name: 'Connected' })).toContainText('Code host');
	await page.getByRole('link', { name: /Code host/ }).click();
	await expect(page.getByText('New on the server')).toBeVisible();
	await expect(page.getByText('Gone from the server')).toBeVisible();
	await expect(
		page.getByText('Added and changed tools are available without approval.', { exact: false })
	).toBeVisible();
	await page.getByRole('button', { name: 'Save tracking snapshot' }).click();
	await expect(page.getByText('Gone from the server')).toHaveCount(0);
	await page.getByRole('tab', { name: 'History', exact: true }).click();
	await expect(page.getByText('Snapshot of 5 tools saved by you.')).toBeVisible();
});

test('adding a server by URL walks address, sign-in and paste-back', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/connectors');
	await page.getByRole('link', { name: 'Add a server by URL' }).click();
	await page
		.getByRole('textbox', { name: 'Server address' })
		.fill('https://mcp.tracker.example/sse');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByText(/Tracker\s+uses a sign-in/)).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open sign-in link' })).toHaveAttribute(
		'href',
		/^https:\/\/mcp\.tracker\.example\/oauth/
	);
	await page.getByRole('button', { name: "I've signed in" }).click();
	const field = page.getByRole('textbox', { name: 'Address from the browser' });
	await field.fill('http://localhost:7461/callback?error=denied');
	await expect(page.getByText('That address has no code.')).toBeVisible();
	await expect(field).toHaveAttribute('aria-invalid', 'true');
	await expect(field).toHaveAccessibleDescription(
		/including its code and state.*That address has no code/
	);
	await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled();
	await field.fill('http://localhost:7461/callback?code=abc&state=q');
	await expect(field).not.toHaveAttribute('aria-invalid', 'true');
	await expect(field).toHaveAccessibleDescription(
		'Copy the whole localhost callback address, including its code and state.'
	);
	await page.getByRole('button', { name: 'Connect' }).click();
	await expect(page).toHaveURL(/\/connectors\/tracker$/, { timeout: 8000 });
	await expect(page.getByText('Connected. The agent can use these tools')).toBeVisible();
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page).toHaveURL(/\/connectors$/);
	await expect(page.getByRole('link', { name: /Tracker/ })).toBeVisible();
});

test('an http address is refused with a reason', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/connectors/add');
	await page.getByRole('textbox', { name: 'Server address' }).fill('http://insecure.example/mcp');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('isn’t an https:// address');
});

test('no servers and a failure say so', async ({ page, context }) => {
	const app = await fixtureApp(context, { fixtures: { connectors: 'empty' } });
	await page.goto('/connectors');
	await expect(page.getByText('No servers yet')).toBeVisible();
	app.set('connectors', 'error');
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("Couldn't load connectors.");
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`connector screens pass axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		for (const [path, ready] of [
			['/connectors', 'Needs attention'],
			['/connectors/code-host', 'Tools'],
			['/connectors/add', 'Server address']
		]) {
			await page.goto(path);
			if (path === '/connectors/code-host') {
				await expect(page.getByRole('tab', { name: ready, exact: true })).toBeVisible();
			} else {
				await expect(page.getByText(ready).first()).toBeVisible();
			}
			await checkScreen(page);
			if (path === '/connectors/code-host') {
				for (const label of ['History', 'Used by']) {
					await page.getByRole('tab', { name: label, exact: true }).click();
					await checkScreen(page);
				}
			}
		}
	});
}

test('Fastmail token connection can disconnect, reconnect and remove its credentials', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/connectors/add');
	await page.getByRole('textbox', { name: 'Server address' }).fill('https://api.fastmail.com/mcp');
	await page.getByLabel('API token (optional)').fill('read-only-test-token');
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await expect(page.getByText('Connected. The agent can use these tools')).toBeVisible();
	await page.getByRole('button', { name: 'Connection actions', exact: true }).click();
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
	await expect(page.getByText('Sign in again', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Connection actions', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
	await expect(page.getByText('Connected', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Connection actions', exact: true }).click();
	await page.getByRole('button', { name: 'Remove…', exact: true }).click();
	await page.getByRole('button', { name: 'Remove connection', exact: true }).click();
	await expect(page).toHaveURL(/\/connectors$/);
	await expect(page.getByRole('link', { name: /api.fastmail.com/ })).toHaveCount(0);
});

test('connection tabs reach history and usage without scrolling through tools', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/connectors/code-host');
	const tools = page.getByRole('tabpanel', { name: 'Tools', exact: true });
	await expect(tools).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save tracking snapshot' })).toBeVisible();
	const viewport = page.locator('[data-tab-pager]');
	const toolsBox = await viewport.boundingBox();
	await expect(page.getByRole('main')).toHaveCSS('overflow-y', 'hidden');
	await expect(tools.getByRole('button', { name: 'Save tracking snapshot' })).toHaveCount(1);
	await page.getByRole('tab', { name: 'History', exact: true }).click();
	expect((await viewport.boundingBox())!.height).toBe(toolsBox!.height);
	await expect(tools).toBeHidden();
	await expect(page.getByRole('heading', { name: 'Connection history' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save tracking snapshot' })).toBeHidden();
	await page.getByRole('tab', { name: 'Used by', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Runs using this connection' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Connection actions', exact: true })).toBeVisible();
	await page.getByRole('tab', { name: 'Tools', exact: true }).click();
	await expect(tools).toBeVisible();
	await expect(page.getByRole('button', { name: 'Save tracking snapshot' })).toBeVisible();
});

test('failed sign-in link copying explains how to recover', async ({ page, context }) => {
	await fixtureApp(context);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: () => Promise.reject(new Error('Clipboard unavailable')) }
		});
	});
	await page.goto('/connectors/add');
	await page
		.getByRole('textbox', { name: 'Server address' })
		.fill('https://mcp.tracker.example/sse');
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Select the link and copy it manually.');
	await expect(page.getByRole('link', { name: 'Open sign-in link' })).toBeVisible();
	await expect(
		page.locator('code').filter({ hasText: 'https://mcp.tracker.example/oauth' })
	).toHaveCSS('user-select', 'text');
});

test('reconnect reports its own progress and failure without implying a snapshot save', async ({
	page,
	context
}) => {
	await page.setViewportSize({ width: 320, height: 640 });
	await fixtureApp(context);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await context.route('**/api/connectors/code-host/reconnect', async (route) => {
		await gate;
		await route.fulfill({
			status: 500,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'The server did not answer.' })
		});
	});
	try {
		await page.goto('/connectors/code-host');
		await page.getByRole('button', { name: 'Connection actions', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
		const pager = page.locator('[data-tab-pager]');
		const before = await pager.boundingBox();
		await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeHidden();
		await expect(page.getByText('Reconnecting…', { exact: true }).first()).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Save tracking snapshot', exact: true })
		).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toHaveCount(0);
		expect((await pager.boundingBox())!.height).toBe(before!.height);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
		release();
		await expect(page.getByRole('alert')).toContainText('Couldn’t reconnect.');
		await expect(page.getByRole('alert')).toHaveCount(1);
		await page.getByRole('button', { name: 'Connection actions', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
	} finally {
		release();
	}
});

test('connection actions support keyboard navigation, Escape and outside dismissal', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/connectors/code-host');
	const trigger = page.getByRole('button', { name: 'Connection actions', exact: true });
	await trigger.click();
	await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeFocused();
	await page.getByRole('heading', { name: 'Code host', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeHidden();
	await expect(page).toHaveURL(/\/connectors\/code-host$/);
});
