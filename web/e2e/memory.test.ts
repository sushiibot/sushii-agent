import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp, openDrawer } from './helpers';

test('Memory separates saved files, daily notes and recorded changes', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chat');
	await (await openDrawer(page)).getByRole('link', { name: /Memory/ }).click();
	await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Long-term files' })).toBeVisible();
	await page.getByRole('tab', { name: 'Daily notes', exact: true }).click();
	await expect(page.getByRole('link', { name: /memory\/2026-09-29\.md/ })).toBeVisible();
	await expect(page.getByRole('link', { name: /MEMORY\.md.*The index/ })).toHaveCount(0);
	await page.getByRole('tab', { name: 'Long-term', exact: true }).click();
	await page.getByRole('searchbox', { name: 'Search memory' }).fill('MEMORY.md');
	await expect(page.getByRole('link', { name: /USER\.md/ })).toHaveCount(0);
	await page.getByRole('link', { name: /MEMORY\.md.*The index/ }).click();
	await expect(page).toHaveURL(/\/memory\/files\/memory-md$/);
	await expect(page.getByRole('region', { name: 'What the file says' })).toContainText(
		'Eastside Auto'
	);
	await page.goBack();
	await page.getByRole('tab', { name: 'Changes', exact: true }).click();
	await page.getByRole('link', { name: 'All 6 changes' }).click();
	await expect(page.getByRole('heading', { name: 'Memory changes', level: 1 })).toBeVisible();
});

test('Memory search distinguishes no matches and clears the active filter', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/memory');
	const panel = page.getByRole('tabpanel', { name: 'Long-term', exact: true });
	const search = page.getByRole('searchbox', { name: 'Search memory' });
	await expect(panel.getByRole('link', { name: /USER\.md/ })).toBeVisible();
	await search.fill('not-a-memory-file');
	await expect(panel.getByText('No matching memory', { exact: true })).toBeVisible();
	await expect(panel.getByText('Nothing remembered yet')).toHaveCount(0);
	await panel.getByRole('button', { name: 'Clear search', exact: true }).click();
	await expect(search).toHaveValue('');
	await expect(panel.getByRole('link', { name: /USER\.md/ })).toBeVisible();
	await search.fill('  mEmOrY.Md  ');
	await expect(panel.getByRole('listitem')).toHaveCount(1);
	await expect(panel.getByRole('link', { name: /MEMORY\.md.*The index/ })).toBeVisible();
});

test('Changes search covers older matches, file paths, summaries and source titles', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/memory');
	await page.getByRole('tab', { name: 'Changes', exact: true }).click();
	const panel = page.getByRole('tabpanel', { name: 'Changes', exact: true });
	const search = page.getByRole('searchbox', { name: 'Search memory' });
	await search.fill('  USER.MD  ');
	await expect(panel.getByRole('listitem')).toHaveCount(2);
	await expect(
		panel.getByRole('link', { name: /Changed: no meetings before 10:00 on Thursdays/ })
	).toBeVisible();
	await search.fill('October trip');
	await expect(panel.getByRole('listitem')).toHaveCount(2);
	await expect(panel.getByRole('link', { name: /Hotel shortlist/ })).toBeVisible();
	await search.fill('HOA meeting');
	await expect(panel.getByRole('listitem')).toHaveCount(1);
	await expect(panel.getByRole('link', { name: /Removed: the old garage/ })).toBeVisible();
	await search.fill('flight booked');
	await expect(panel.getByRole('listitem')).toHaveCount(1);
	await expect(panel.getByRole('link', { name: /Daily note: flight booked/ })).toBeVisible();
	await search.fill('no-such-change');
	await expect(panel.getByText('No matching memory', { exact: true })).toBeVisible();
	await expect(panel.getByText('No changes match your search.', { exact: false })).toBeVisible();
});

test('a failed Memory refresh preserves cached rows and offers an inline retry', async ({
	page,
	context
}) => {
	const app = await fixtureApp(context);
	await page.goto('/memory');
	const panel = page.getByRole('tabpanel', { name: 'Long-term', exact: true });
	const saved = panel.getByRole('link', { name: /MEMORY\.md.*The index/ });
	await expect(saved).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
	const before = await saved.boundingBox();
	app.set('memory', 'error');
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(panel.getByRole('alert')).toContainText("Couldn't refresh memory.");
	await expect(saved).toBeVisible();
	expect((await saved.boundingBox())!.y).toBe(before!.y);
	app.set('memory', 'normal');
	await panel.getByRole('button', { name: 'Retry refresh' }).click();
	await expect(panel.getByRole('alert')).toHaveCount(0);
	await expect(saved).toBeVisible();
});

test('a change shows its diff and who wrote it, and Revert offers Restore', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/memory/writes/w-vendor');
	await expect(page.getByText('Added: Eastside Auto prefers email for scheduling')).toBeVisible();
	await expect(page.getByText('Added:', { exact: true })).toBeAttached();
	await expect(page.getByText('The run had read an outside email')).toBeVisible();
	await page.getByRole('link', { name: /What's the invoice from Eastside Auto/ }).click();
	await expect(page).toHaveURL(/\/runs\/01K6B4A0C2E4G6J8M0P2R4T6V8$/);
	await page.goBack();
	await page.getByRole('button', { name: 'Revert this change' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Change reverted' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Restore this change' })).toBeVisible();
	await page.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Revert this change' })).toBeVisible();
});

test('empty, failing and unknown memory screens say so', async ({ page, context }) => {
	const app = await fixtureApp(context, { fixtures: { memory: 'empty' } });
	await page.goto('/memory');
	await expect(
		page
			.getByRole('tabpanel', { name: 'Long-term', exact: true })
			.getByText('Nothing remembered yet')
	).toBeVisible();
	app.set('memory', 'error');
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("Couldn't load memory.");
	app.set('memory', 'normal');
	await page.goto('/memory/writes/nope');
	await expect(page.getByText('No such change')).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Memory screens pass axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		for (const [path, ready] of [
			['/memory', 'Long-term files'],
			['/memory/writes', 'Memory changes'],
			['/memory/writes/w-thursday', 'Changed: no meetings'],
			['/memory/files/user-md', 'Changes to this file']
		]) {
			await page.goto(path);
			await expect(page.getByText(ready).first()).toBeVisible();
			await checkScreen(page);
		}
	});
}
