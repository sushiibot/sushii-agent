import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test('connectors list servers, and a changed tool list waits to be accepted', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/connectors');
	await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('Code host');
	await page.getByRole('link', { name: /Code host/ }).click();
	await expect(page.getByText('New on the server')).toBeVisible();
	await expect(page.getByText('Gone from the server')).toBeVisible();
	await page.getByRole('button', { name: 'Accept the new tool list' }).click();
	await expect(page.getByText('Snapshot of 5 tools saved by you.')).toBeVisible();
	await expect(page.getByText('Gone from the server')).toHaveCount(0);
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
	await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled();
	await field.fill('http://localhost:7461/callback?code=abc&state=q');
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
	await fixtureApp(context, { fixtures: { connectors: 'empty' } });
	await page.goto('/connectors');
	await expect(page.getByText('No servers yet')).toBeVisible();
	await page.evaluate(() => localStorage.setItem('fixtures:connectors', 'error'));
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
			['/connectors/code-host', 'Used by'],
			['/connectors/add', 'Server address']
		]) {
			await page.goto(path);
			await expect(page.getByText(ready).first()).toBeVisible();
			await checkScreen(page);
		}
	});
}
