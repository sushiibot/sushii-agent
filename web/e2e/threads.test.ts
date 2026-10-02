import { expect, test } from '@playwright/test';
import { checkScreen, fixtureApp, openDrawer } from './helpers';

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
	await expect(page.getByRole('heading', { name: 'Threads', level: 1 })).toBeVisible();
	const menu = await openDrawer(page);
	await expect(menu.getByRole('link', { name: 'Threads' })).toHaveAttribute('aria-current', 'page');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('region', { name: 'Chat' })).toContainText(
		'Your general-purpose conversation'
	);
	for (const h of ['Needs you', 'Running', 'Recent', 'Archived']) {
		await expect(page.getByRole('heading', { name: new RegExp(`^${h}`) })).toBeVisible();
	}
	await expect(page.getByRole('region', { name: /^Archived/ })).toContainText('Couch delivery');
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
	await context.route('**/api/models?conversationId=oct-trip', (route) =>
		route.fulfill({
			json: {
				current: 'sol',
				cost: {
					session: { usd: 0.24, recordedRuns: 2, unpricedRuns: 0 },
					today: { usd: 1.25, recordedRuns: 6, unpricedRuns: 0 },
					date: '2026-10-01',
					timeZone: 'America/Los_Angeles'
				},
				models: [{ alias: 'sol', backend: 'chatgpt', id: 'gpt-6.1-sol' }]
			}
		})
	);
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
	await page.getByRole('button', { name: /^Model: .*Change model$/ }).click();
	const model = page.getByRole('dialog', { name: /^Model/ });
	await expect(model).toBeVisible();
	await expect(model.getByRole('region', { name: 'Cost', exact: true })).toContainText('$0.240');
	await page.goBack();
	await expect(model).toBeHidden();
});

test('archiving stays in the conversation and keeps the thread visible below current threads', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats/oct-trip');
	await page.getByRole('button', { name: 'Archive', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Archive thread' });
	await expect(sheet).not.toContainText('Report to Main');
	await sheet.getByRole('button', { name: 'Archive thread', exact: true }).click();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(/\/chats\/oct-trip$/);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await page.goto('/chats');
	await expect(page.getByRole('region', { name: /^Archived/ })).toContainText('October trip');
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
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('an automatically archived thread remains directly sendable', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/chats/couch');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0);
});

test('a list that fails to load says so and retries', async ({ page, context }) => {
	const app = await fixtureApp(context, { fixtures: { threads: 'error' } });
	await page.goto('/chats');
	await expect(page.getByRole('alert')).toContainText("Couldn't load your threads.");
	app.set('threads', 'normal');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByRole('link', { name: /October trip/ })).toBeVisible();
});

test('with threads off, Chat is one conversation with no Chats list', async ({ page, context }) => {
	await fixtureApp(context, { override: '' });
	await page.goto('/chat');
	await expect((await openDrawer(page)).getByRole('link', { name: 'Threads' })).toHaveCount(0);
	await page.goto('/chats');
	await expect(page).toHaveURL(/\/chat$/);
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
		await page.getByRole('button', { name: 'Archive' }).click();
		await expect(page.getByRole('dialog', { name: 'Archive thread' })).toBeVisible();
		await checkScreen(page);
	});
}
