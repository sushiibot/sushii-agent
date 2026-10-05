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
	await page.getByRole('button', { name: 'Chat commands', exact: true }).click();
	await page.getByRole('button', { name: 'Archive thread', exact: true }).click();
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
		await page.getByRole('button', { name: 'Chat commands', exact: true }).click();
		await checkScreen(page);
		await page.getByRole('button', { name: 'Archive thread', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Archive thread' })).toBeVisible();
		await checkScreen(page);
	});
}

test('thread settings saves a name and preserves the conversation across a reload', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats/oct-trip');
	await page.getByRole('button', { name: 'Chat commands', exact: true }).click();
	await page.getByRole('button', { name: 'Rename thread', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Thread settings' });
	const name = sheet.getByRole('textbox', { name: 'Thread name' });
	await expect(name).toHaveValue('October trip');
	await expect(sheet.getByRole('button', { name: 'Save name' })).toBeDisabled();
	await name.fill('  Japan trip  ');
	await sheet.getByRole('button', { name: 'Save name' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('heading', { name: 'Japan trip', level: 1 })).toBeVisible();
	await expect(page.getByText('Picking up the trip here.')).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Japan trip', level: 1 })).toBeVisible();
	await page.goto('/chats');
	await expect(page.getByRole('link', { name: /Japan trip/ })).toBeVisible();
});

test('row options rename archived threads and Back cancels unsaved changes', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await page.getByRole('button', { name: 'Options for Couch delivery' }).click();
	const sheet = page.getByRole('dialog', { name: 'Thread settings' });
	await expect(sheet.getByRole('button', { name: 'Archive thread' })).toHaveCount(0);
	await sheet.getByRole('textbox', { name: 'Thread name' }).fill('Unsaved');
	await page.goBack();
	await expect(sheet).toBeHidden();
	await page.getByRole('button', { name: 'Options for Couch delivery' }).click();
	await expect(sheet.getByRole('textbox', { name: 'Thread name' })).toHaveValue('Couch delivery');
	await sheet.getByRole('textbox', { name: 'Thread name' }).fill('Delivered couch');
	await sheet.getByRole('button', { name: 'Save name' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('region', { name: /^Archived/ })).toContainText('Delivered couch');
});

test('a failed rename keeps the sheet and its edited name available for retry', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	let failed = false;
	await context.route('**/api/threads/oct-trip/rename', async (route) => {
		if (!failed) {
			failed = true;
			await route.fulfill({ status: 503, json: { error: 'Workspace unavailable' } });
		} else await route.fallback();
	});
	await page.goto('/chats/oct-trip');
	await page.getByRole('button', { name: 'Chat commands', exact: true }).click();
	await page.getByRole('button', { name: 'Rename thread', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Thread settings' });
	await sheet.getByRole('textbox', { name: 'Thread name' }).fill('Japan trip');
	await sheet.getByRole('button', { name: 'Save name' }).click();
	await expect(sheet.getByRole('alert')).toContainText("Couldn't update the thread");
	await expect(sheet.getByRole('textbox', { name: 'Thread name' })).toHaveValue('Japan trip');
	await sheet.getByRole('button', { name: 'Save name' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('heading', { name: 'Japan trip', level: 1 })).toBeVisible();
});

test('long press opens row options, while a scroll gesture and a short tap do not', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats');
	const row = page.getByRole('link', { name: /October trip/ });
	const down = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 300 };
	await row.dispatchEvent('pointerdown', down);
	await row.dispatchEvent('pointermove', { ...down, clientY: 330 });
	await page.waitForTimeout(550);
	const sheet = page.getByRole('dialog', { name: 'Thread settings' });
	await expect(sheet).toBeHidden();
	await row.dispatchEvent('pointerup', down);
	await row.dispatchEvent('pointerdown', down);
	await expect(sheet).toBeVisible();
	await expect(page).toHaveURL(/\/chats$/);
	// The click delivered after a completed long press must not follow the thread link.
	await row.dispatchEvent('pointerup', down);
	await row.dispatchEvent('click');
	await expect(page).toHaveURL(/\/chats$/);
	await page.goBack();
	await expect(sheet).toBeHidden();
	await row.click();
	await expect(page).toHaveURL(/\/chats\/oct-trip$/);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`thread settings passes axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		await page.goto('/chats');
		await page.getByRole('button', { name: 'Options for October trip' }).click();
		await expect(page.getByRole('dialog', { name: 'Thread settings' })).toBeVisible();
		await checkScreen(page);
	});
}

test('refreshing thread metadata preserves an open name draft and archive confirmation', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await page.getByRole('button', { name: 'Options for October trip' }).click();
	const sheet = page.getByRole('dialog', { name: 'Thread settings' });
	await sheet.getByRole('textbox', { name: 'Thread name' }).fill('My unsaved name');
	async function remoteRename(title: string) {
		await page.evaluate(async (title) => {
			await fetch('/api/threads/oct-trip/rename', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title })
			});
		}, title);
		const refreshed = page.waitForResponse(
			(response) => response.url().endsWith('/api/chats') && response.request().method() === 'GET'
		);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await refreshed;
		await expect(page.getByRole('button', { name: `Options for ${title}` })).toBeAttached();
	}
	await remoteRename('Changed elsewhere');
	await expect(sheet.getByRole('textbox', { name: 'Thread name' })).toHaveValue('My unsaved name');
	await sheet.getByRole('button', { name: 'Archive thread', exact: true }).click();
	await expect(sheet.getByText('Archive Changed elsewhere?', { exact: true })).toBeVisible();
	await remoteRename('Changed again');
	await expect(sheet.getByText('Archive Changed again?', { exact: true })).toBeVisible();
	await sheet.getByRole('button', { name: 'Keep current' }).click();
	await expect(sheet.getByRole('textbox', { name: 'Thread name' })).toHaveValue('My unsaved name');
});

test('thread context details use a sheet that Back closes without leaving the thread', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await context.route('**/api/threads/oct-trip/chat/history*', (route) =>
		route.fulfill({
			json: {
				items: [
					{
						type: 'divider',
						id: 'topic-compaction',
						at: new Date().toISOString(),
						kind: 'compacted',
						summary: 'Keep the October hotel shortlist.',
						memory: { files: [], truncated: false }
					}
				],
				before: null
			}
		})
	);
	await page.goto('/chats/oct-trip');
	const divider = page.getByRole('button', { name: 'Conversation compacted' });
	await divider.click();
	const sheet = page.getByRole('dialog', { name: 'Conversation compacted' });
	await expect(sheet).toContainText('Keep the October hotel shortlist.');
	await page.goBack();
	await expect(sheet).toBeHidden();
	await expect(divider).toBeFocused();
	await expect(page).toHaveURL(/\/chats\/oct-trip$/);
	await page.goForward();
	await expect(sheet).toBeVisible();
	await sheet.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(sheet).toBeHidden();
});

test('context usage belongs to the selected thread rather than Main or its last reply', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await context.route('**/api/models?conversationId=oct-trip', (route) =>
		route.fulfill({
			json: {
				current: 'sol',
				models: [{ alias: 'sol', backend: 'chatgpt', id: 'gpt-6.1-sol' }],
				context: {
					tokens: 8000,
					window: 200000,
					percent: 4,
					estimated: true,
					compactAt: 150000,
					model: 'topic/model',
					status: 'ready'
				}
			}
		})
	);
	await page.goto('/chats/oct-trip');
	await page.getByRole('button', { name: 'Model: sol. Change model' }).click();
	const sheet = page.getByRole('dialog', { name: 'Model and context' });
	await expect(sheet).toContainText('About 8,000 of 200,000 tokens');
	await expect(sheet).toContainText('Active model: model');
	await page.goBack();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(/\/chats\/oct-trip$/);
});
