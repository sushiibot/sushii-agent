import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test('each briefing item has its source and plain buttons to rate or dismiss it', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/briefing');
	await expect(page.getByRole('heading', { name: 'Top of mind' })).toBeVisible();
	await expect(page.getByText('Source: Email from Eastside Auto')).toBeVisible();
	const useful = page.getByRole('button', { name: 'Useful', exact: true }).first();
	await useful.click();
	await expect(useful).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByText('1 rated.')).toBeVisible();
	await useful.click();
	await expect(useful).toHaveAttribute('aria-pressed', 'false');
	await page.getByRole('button', { name: 'Dismiss' }).first().click();
	await expect(page.getByText(/^Dismissed: The garage/)).toBeVisible();
	await expect(page.getByText('4 of 5 open')).toBeVisible();
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByText('5 of 5 open')).toBeVisible();
	await page.getByRole('link', { name: /Run · Back up projects/ }).click();
	await expect(page).toHaveURL(/\/runs\//);
});

test('no briefing yet and a failure say so', async ({ page, context }) => {
	const app = await fixtureApp(context, { fixtures: { briefing: 'empty' } });
	await page.goto('/briefing');
	await expect(page.getByText('No briefing yet today')).toBeVisible();
	app.set('briefing', 'error');
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("Couldn't load the briefing.");
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the briefing passes axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		await page.goto('/briefing');
		await expect(page.getByRole('heading', { name: 'Top of mind' })).toBeVisible();
		await page.getByRole('button', { name: 'Not useful' }).first().click();
		await checkScreen(page);
	});
}
