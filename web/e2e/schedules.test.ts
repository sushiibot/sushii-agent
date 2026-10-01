import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test('Schedules lead with the failed job, and each job shows its next run', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/schedules');
	const failed = page.getByRole('region', { name: /Last run failed/ });
	await expect(failed).toContainText('Back up projects');
	await expect(page.getByRole('link', { name: /Inbox watch/ })).toContainText('Next run in');
	await expect(page.getByRole('link', { name: /Backup check/ })).toContainText(
		'Paused, no next run'
	);
	await page.getByRole('link', { name: /Inbox watch/ }).click();
	await expect(page.getByText('12 new, none needed you').first()).toBeVisible();
	await expect(page.getByText('Suppressed')).toBeVisible();
});

test('a test run reports progress, then its result, with nothing sent', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/schedules/briefing');
	await page.getByRole('button', { name: 'Test run' }).click();
	await expect(page.getByRole('status').filter({ hasText: /step|Starting/ })).toBeVisible();
	await expect(page.getByText('Would have sent a message. Nothing was sent.')).toBeVisible({
		timeout: 6000
	});
	await expect(page.getByRole('button', { name: 'Test again' })).toBeVisible();
});

test('pausing a job removes its next run', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/schedules/briefing');
	await page.getByRole('switch', { name: /Runs on its schedule/ }).click();
	await expect(page.getByText('Paused, no next run')).toBeVisible();
});

test('empty and failing schedules say so', async ({ page, context }) => {
	await fixtureApp(context, { fixtures: { schedules: 'empty' } });
	await page.goto('/schedules');
	await expect(page.getByText('No scheduled jobs')).toBeVisible();
	await page.evaluate(() => localStorage.setItem('fixtures:schedules', 'error'));
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("Couldn't load schedules.");
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Schedules screens pass axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		await page.goto('/schedules');
		await expect(page.getByRole('link', { name: /Inbox watch/ })).toBeVisible();
		await checkScreen(page);
		await page.goto('/schedules/nightly-sync');
		await expect(page.getByText('Recent runs')).toBeVisible();
		await checkScreen(page);
	});
}
