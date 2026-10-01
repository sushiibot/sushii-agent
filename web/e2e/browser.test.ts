import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test('taking over the browser locks the agent out until you hand back', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/browser');
	await expect(
		page.getByRole('status').filter({ hasText: 'The agent is using the browser' })
	).toBeVisible();
	await expect(page.getByText('https://accounts.example.com/signin')).toBeVisible();
	await page.getByRole('button', { name: 'Take over the browser' }).click();
	await expect(page.getByRole('button', { name: /Waiting for the agent/ })).toBeDisabled();
	await expect(
		page.getByRole('status').filter({ hasText: /You're driving[\s\S]*locked out/ })
	).toBeVisible({ timeout: 6000 });
	await page.getByRole('button', { name: 'Hand back to the agent' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'The agent is using the browser' })
	).toBeVisible();
});

test('an idle browser and a failure say so', async ({ page, context }) => {
	await fixtureApp(context, { fixtures: { browser: 'empty' } });
	await page.goto('/browser');
	await expect(page.getByText('The agent isn’t using the browser')).toBeVisible();
	await page.evaluate(() => localStorage.setItem('fixtures:browser', 'error'));
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("Couldn't reach the browser.");
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the browser screen passes axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		await page.goto('/browser');
		await expect(
			page.getByRole('status').filter({ hasText: 'The agent is using the browser' })
		).toBeVisible();
		await checkScreen(page);
	});
}
