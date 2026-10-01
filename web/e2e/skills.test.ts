import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test('Skills group by stage and a skill shows why, its lifecycle and its runs', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/skills');
	for (const h of ['In use', 'Drafts', 'Stale', 'Archived'])
		await expect(page.getByRole('heading', { name: new RegExp(`^${h}`) })).toBeVisible();
	await page.getByRole('link', { name: /deploy-relay-bot/ }).click();
	await expect(page).toHaveURL(/\/skills\/deploy-relay-bot$/);
	await expect(page.getByText('Promoted after 5 runs in a row')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Lifecycle' })).toBeVisible();
	await page.getByRole('link', { name: /Versions and SKILL\.md/ }).click();
	await expect(page.getByRole('heading', { name: /SKILL\.md now, version 3/ })).toBeVisible();
	await expect(page.getByText('Removed:', { exact: true }).first()).toBeAttached();
	await page.getByText('Version 2', { exact: true }).click();
	await expect(page.getByText('Added a health check before the switch.')).toBeVisible();
});

test('a draft can be put to use from a button at the bottom', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/skills/rent-receipts');
	await page.getByRole('button', { name: 'Use it now' }).click();
	await expect(page.getByText('Made active by you.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Use it now' })).toHaveCount(0);
});

test('no skills, a failure and an unknown skill all say so', async ({ page, context }) => {
	await fixtureApp(context, { fixtures: { skills: 'empty' } });
	await page.goto('/skills');
	await expect(page.getByText('No skills yet')).toBeVisible();
	await page.evaluate(() => localStorage.setItem('fixtures:skills', 'error'));
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("Couldn't load skills.");
	await page.evaluate(() => localStorage.removeItem('fixtures:skills'));
	await page.goto('/skills/nope');
	await expect(page.getByText('No such skill')).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Skills screens pass axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		for (const [path, ready] of [
			['/skills', 'In use'],
			['/skills/rent-receipts', 'Lifecycle'],
			['/skills/deploy-relay-bot/versions', 'SKILL.md now']
		]) {
			await page.goto(path);
			await expect(page.getByText(ready).first()).toBeVisible();
			await checkScreen(page);
		}
	});
}
