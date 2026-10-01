import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test('Memory lists recent changes and files, each opening its own screen', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/more');
	await page.getByRole('link', { name: /Memory/ }).click();
	await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Recent changes' })).toBeVisible();
	await page.getByRole('link', { name: /MEMORY\.md.*The index/ }).click();
	await expect(page).toHaveURL(/\/memory\/files\/memory-md$/);
	await expect(page.getByRole('region', { name: 'What the file says' })).toContainText(
		'Eastside Auto'
	);
	await page.goBack();
	await page.getByRole('link', { name: 'All 6 changes' }).click();
	await expect(page.getByRole('heading', { name: 'Memory changes', level: 1 })).toBeVisible();
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
	await fixtureApp(context, { fixtures: { memory: 'empty' } });
	await page.goto('/memory');
	await expect(page.getByText('Nothing remembered yet')).toBeVisible();
	await page.evaluate(() => localStorage.setItem('fixtures:memory', 'error'));
	await page.reload();
	await expect(page.getByRole('alert')).toContainText("Couldn't load memory.");
	await page.evaluate(() => localStorage.removeItem('fixtures:memory'));
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
			['/memory', 'Recent changes'],
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
