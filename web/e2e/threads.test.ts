import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

const reply = {
	type: 'assistant',
	id: 'a1',
	at: new Date().toISOString(),
	text: 'Three hotels fit: the inn, the loft hotel and the ryokan.',
	tools: [],
	files: []
};

test('Chats pins Main and groups threads by what they need', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await expect(page.getByRole('heading', { name: 'Chats', level: 1 })).toBeVisible();
	const tabs = page.locator('nav[aria-label="Main"]').last();
	await expect(tabs.getByRole('link', { name: 'Chats' })).toHaveAttribute('aria-current', 'page');
	await expect(page.getByRole('region', { name: 'Main' })).toContainText(
		'Threads report back here'
	);
	for (const h of ['Needs you', 'Running', 'Recent', 'Archived']) {
		await expect(page.getByRole('heading', { name: new RegExp(`^${h}`) })).toBeVisible();
	}
	await expect(page.getByText('Couch delivery was archived after 7 idle days.')).toBeVisible();
	await page.getByRole('searchbox').fill('lease');
	await expect(page.getByRole('heading', { name: '1 matching' })).toBeVisible();
	await page.getByRole('link', { name: /Lease renewal/ }).click();
	await expect(page).toHaveURL(/\/chats\/lease$/);
});

test('a thread says it shares memory with Main, and back closes its sheet', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await page.getByRole('link', { name: /October trip/ }).click();
	await expect(page.getByRole('heading', { name: 'October trip', level: 1 })).toBeVisible();
	await expect(page.getByText('Brief from Main')).toBeVisible();
	await expect(page.getByText('Picking up the trip here.')).toBeVisible();
	await page.getByRole('button', { name: /Shares memory with Main · 2 writes/ }).click();
	const sheet = page.getByRole('dialog', { name: 'Memory shared with Main' });
	await expect(sheet).toContainText('2 writes from this thread');
	await page.goBack();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(/\/chats\/oct-trip$/);
});

test('closing a thread archives it and leaves a report in Main', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await page.getByRole('link', { name: /October trip/ }).click();
	await page.getByRole('button', { name: 'Close' }).click();
	const sheet = page.getByRole('dialog', { name: 'Close thread' });
	await expect(sheet).toContainText('Report to Main');
	await sheet.getByRole('button', { name: 'Close thread' }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('link', { name: /Thread closed · October trip/ })).toBeVisible();
	await page.getByRole('link', { name: 'Back to Chats' }).click();
	await expect(page).toHaveURL(/\/chats$/);
	await expect(page.getByRole('link', { name: /October trip/ })).toContainText('Reported to Main');
});

test('a reply in Main starts a thread from a visible button', async ({ page, context }) => {
	await fixtureApp(context, { history: [reply] });
	await page.goto('/chat');
	await page.getByRole('button', { name: 'Start a thread from here' }).click();
	const sheet = page.getByRole('dialog', { name: 'Start a thread' });
	await expect(sheet).toContainText('Three hotels fit');
	await sheet.getByRole('textbox', { name: 'Thread name' }).fill('Hotel choice');
	await sheet.getByRole('button', { name: 'Start thread' }).click();
	await expect(page).toHaveURL(/\/chats\/hotel-choice$/);
	await expect(page.getByRole('heading', { name: 'Hotel choice', level: 1 })).toBeVisible();
	// Until the agent runs threads, a thread can't take messages, so nothing can reach Main.
	await expect(page.getByText("the agent can't take messages in threads yet")).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
});

test('an idle thread archived by itself is read only until reopened', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/chats/couch');
	await expect(page.getByText(/after a week with nothing new\. Read only\./)).toBeVisible();
	await page.getByRole('button', { name: 'Reopen' }).click();
	await expect(page.getByText(/after a week with nothing new/)).toHaveCount(0);
	await expect(page.getByText("the agent can't take messages in threads yet")).toBeVisible();
});

test('a list that fails to load says so and retries', async ({ page, context }) => {
	const app = await fixtureApp(context, { fixtures: { threads: 'error' } });
	await page.goto('/chats');
	await expect(page.getByRole('alert')).toContainText("Couldn't load your chats.");
	app.set('threads', 'normal');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByRole('link', { name: /October trip/ })).toBeVisible();
});

test('with threads off, Chat is one conversation that goes back Home', async ({
	page,
	context
}) => {
	await fixtureApp(context, { override: '' });
	await page.goto('/chat');
	await expect(page.getByRole('link', { name: 'Back to Home' })).toBeAttached();
	await page.goto('/chats');
	await expect(page).toHaveURL(/\/$/);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Chats and a thread pass axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		await page.goto('/chats');
		await expect(page.getByRole('link', { name: /October trip/ })).toBeVisible();
		await checkScreen(page);
		await page.goto('/chats/oct-trip');
		await expect(page.getByText('Brief from Main')).toBeVisible();
		await checkScreen(page);
		await page.getByRole('button', { name: 'Close' }).click();
		await expect(page.getByRole('dialog', { name: 'Close thread' })).toBeVisible();
		await checkScreen(page);
	});
}
