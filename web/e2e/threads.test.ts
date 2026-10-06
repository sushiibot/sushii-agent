import { expect, test } from '@playwright/test';
import { homeData, emailApproval } from '../src/lib/features/home/fixtures';
import { checkScreen, fixtureApp, openDrawer, openSharedInbox } from './helpers';

const reply = {
	type: 'assistant',
	id: 'a1',
	at: new Date().toISOString(),
	text: 'Three hotels fit: the inn, the loft hotel and the ryokan.',
	tools: [],
	files: []
};

test('Conversations keeps Main first, a shared inbox and working thread search', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await expect(page.getByRole('heading', { name: 'Conversations', level: 1 })).toBeVisible();
	const menu = await openDrawer(page);
	await expect(menu.getByRole('link', { name: 'Conversations' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('region', { name: 'Main chat' })).not.toContainText('Pinned');
	for (const h of ['Threads', 'Archived']) {
		await expect(page.getByRole('heading', { name: new RegExp(`^${h}`) })).toBeVisible();
	}
	await expect(page.getByRole('region', { name: /^Archived/ })).toContainText('Couch delivery');
	await openSharedInbox(page);
	await expect(page.locator('details[data-inbox="shared"]')).toContainText('nightly-sync failed');
	await page.getByRole('searchbox').fill('lease');
	await expect(page.getByRole('heading', { name: '1 matching' })).toBeVisible();
	await page.getByRole('link', { name: /Lease renewal/ }).click();
	await expect(page).toHaveURL(/\/chats\/lease$/);
});

test('closing an inbox expanded by a slow load stays closed when its records arrive', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	let release!: () => void;
	const loaded = new Promise<void>((resolve) => (release = resolve));
	const data = homeData(Date.now());
	await context.route('**/api/home', async (route) => {
		await loaded;
		await route.fulfill({
			json: { ...data, waiting: { approvals: [], asks: [], auth: data.auth }, openTurns: [] }
		});
	});
	await page.goto('/chats');
	const inbox = page.locator('details[data-inbox="shared"]');
	try {
		await expect(inbox).toHaveAttribute('open', '');
		await inbox.locator('summary').click();
		await expect(inbox).not.toHaveAttribute('open', '');
	} finally {
		release();
	}
	await expect(inbox.locator('summary')).toContainText(/Inbox · \d+/);
	await expect(inbox).not.toHaveAttribute('open', '');
});

test('decisions name their source while topic work and heartbeats share one inbox', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	const data = homeData(Date.now());
	data.workspace.failedRuns[0].conversationId = 'oct-trip';
	await context.route('**/api/home', (route) =>
		route.fulfill({
			json: { ...data, waiting: { approvals: [], asks: [], auth: data.auth }, openTurns: [] }
		})
	);
	await context.addInitScript(
		(view) => {
			const stream = (
				window as unknown as { __sse: { hello: { pending: { approvals: unknown[] } } } }
			).__sse;
			stream.hello.pending.approvals.push({
				seq: 3,
				at: new Date().toISOString(),
				nonce: 'topic-approval',
				view
			});
		},
		{ ...emailApproval.view, conversationId: 'oct-trip' }
	);
	await page.goto('/chats');
	const attention = page.getByRole('region', { name: 'Needs you', exact: true });
	await expect(attention).toContainText('October trip');
	await expect(attention.getByRole('button', { name: /Approve send_email/ })).toBeVisible();
	const main = page.getByRole('region', { name: 'Main chat', exact: true });
	expect((await attention.boundingBox())!.y).toBeLessThan((await main.boundingBox())!.y);
	const inbox = page.locator('details[data-inbox="shared"]');
	await inbox.locator('summary').click();
	await expect(inbox).toContainText('Compare flight prices for the October trip');
	await expect(inbox).toContainText('Your passport renewal is due Friday');
	await expect(main).not.toContainText('Compare flight prices');
	await expect(main).not.toContainText('Your passport renewal');
	await expect(page.locator('details[data-inbox]')).toHaveCount(1);
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
	await expect(sheet).toContainText('2 writes from this conversation');
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
	await page.getByRole('button', { name: 'Archive conversation', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Archive conversation' });
	await expect(sheet).not.toContainText('Report to Main');
	await sheet.getByRole('button', { name: 'Archive conversation', exact: true }).click();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(/\/chats\/oct-trip$/);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await page.goto('/chats');
	await expect(page.getByRole('region', { name: /^Archived/ })).toContainText('October trip');
});

test('a reply in Main starts a thread from a visible button', async ({ page, context }) => {
	await fixtureApp(context, { history: [reply] });
	await page.goto('/chat');
	await page.getByRole('button', { name: 'Start a conversation from here' }).click();
	const sheet = page.getByRole('dialog', { name: 'Start a conversation' });
	await expect(sheet).toContainText('Three hotels fit');
	await sheet.getByRole('textbox', { name: 'Conversation name' }).fill('Hotel choice');
	await sheet.getByRole('button', { name: 'Start conversation' }).click();
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
	await expect(page.getByRole('alert')).toContainText("Couldn't load your conversations.");
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
		await openSharedInbox(page);
		await page.getByRole('button', { name: /Your passport renewal is due Friday/ }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Discuss', exact: true }).click();
		const picker = page.getByRole('dialog', { name: 'Discuss in a conversation' });
		await checkScreen(page);
		await picker.getByRole('button', { name: 'New conversation', exact: true }).click();
		await checkScreen(page);
		await page.goto('/chats/oct-trip');
		await expect(page.getByText('Brief from Main')).toBeVisible();
		await checkScreen(page);
		await page.getByRole('button', { name: 'Chat commands', exact: true }).click();
		await checkScreen(page);
		await page.getByRole('button', { name: 'Archive conversation', exact: true }).click();
		await expect(page.getByRole('dialog', { name: 'Archive conversation' })).toBeVisible();
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
	await page.getByRole('button', { name: 'Rename conversation', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Conversation settings' });
	const name = sheet.getByRole('textbox', { name: 'Conversation name' });
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
	const sheet = page.getByRole('dialog', { name: 'Conversation settings' });
	await expect(sheet.getByRole('button', { name: 'Archive conversation' })).toHaveCount(0);
	await sheet.getByRole('textbox', { name: 'Conversation name' }).fill('Unsaved');
	await page.goBack();
	await expect(sheet).toBeHidden();
	await page.getByRole('button', { name: 'Options for Couch delivery' }).click();
	await expect(sheet.getByRole('textbox', { name: 'Conversation name' })).toHaveValue(
		'Couch delivery'
	);
	await sheet.getByRole('textbox', { name: 'Conversation name' }).fill('Delivered couch');
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
	await page.getByRole('button', { name: 'Rename conversation', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Conversation settings' });
	await sheet.getByRole('textbox', { name: 'Conversation name' }).fill('Japan trip');
	await sheet.getByRole('button', { name: 'Save name' }).click();
	await expect(sheet.getByRole('alert')).toContainText("Couldn't update the conversation");
	await expect(sheet.getByRole('textbox', { name: 'Conversation name' })).toHaveValue('Japan trip');
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
	const sheet = page.getByRole('dialog', { name: 'Conversation settings' });
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
		await expect(page.getByRole('dialog', { name: 'Conversation settings' })).toBeVisible();
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
	const sheet = page.getByRole('dialog', { name: 'Conversation settings' });
	await sheet.getByRole('textbox', { name: 'Conversation name' }).fill('My unsaved name');
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
	await expect(sheet.getByRole('textbox', { name: 'Conversation name' })).toHaveValue(
		'My unsaved name'
	);
	await sheet.getByRole('button', { name: 'Archive conversation', exact: true }).click();
	await expect(sheet.getByText('Archive Changed elsewhere?', { exact: true })).toBeVisible();
	await remoteRename('Changed again');
	await expect(sheet.getByText('Archive Changed again?', { exact: true })).toBeVisible();
	await sheet.getByRole('button', { name: 'Keep current' }).click();
	await expect(sheet.getByRole('textbox', { name: 'Conversation name' })).toHaveValue(
		'My unsaved name'
	);
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

test('Discuss puts a heartbeat in the selected topic draft, preserves text and does not send', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	const sent: string[] = [];
	page.on('request', (request) => {
		if (
			request.method() === 'POST' &&
			/\/api\/(?:chat|threads\/[^/]+\/chat)\/messages(?:\?|$)/.test(request.url())
		)
			sent.push(request.url());
	});
	await page.goto('/chats/oct-trip');
	await page
		.getByRole('textbox', { name: 'Message', exact: true })
		.fill('Keep these travel notes.');
	await page.getByRole('link', { name: 'Back to Conversations' }).click();
	await openSharedInbox(page);
	await page.getByRole('button', { name: /Your passport renewal is due Friday/ }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Discuss', exact: true }).click();
	const picker = page.getByRole('dialog', { name: 'Discuss in a conversation' });
	await picker.getByRole('searchbox', { name: 'Find a conversation' }).fill('October');
	await picker.getByRole('button', { name: 'October trip', exact: true }).click();
	await expect(page).toHaveURL(/\/chats\/oct-trip$/);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
		/^Keep these travel notes\.\n\n> From heartbeat:\n> Your passport renewal/
	);
	expect(sent).toEqual([]);
});

test('Discuss creates a named conversation with the heartbeat in an unsent draft', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await openSharedInbox(page);
	await page.getByRole('button', { name: /Your passport renewal is due Friday/ }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Discuss', exact: true }).click();
	const picker = page.getByRole('dialog', { name: 'Discuss in a conversation' });
	await picker.getByRole('button', { name: 'New conversation', exact: true }).click();
	await picker.getByRole('textbox', { name: 'Conversation name' }).fill('Passport renewal');
	await picker.getByRole('button', { name: 'Create conversation', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Passport renewal', level: 1 })).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
		/^> From heartbeat:\n> Your passport renewal/
	);
});

test('Discuss can return to the item and recover from a conversation load failure', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await context.route('**/api/threads/oct-trip', (route) =>
		route.fulfill({ status: 500, json: { error: 'Temporarily unavailable' } })
	);
	await page.goto('/chats');
	await openSharedInbox(page);
	await page.getByRole('button', { name: /Your passport renewal is due Friday/ }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Discuss', exact: true }).click();
	const picker = page.getByRole('dialog', { name: 'Discuss in a conversation' });
	await picker.getByRole('button', { name: 'October trip', exact: true }).click();
	await expect(picker.getByRole('alert')).toBeVisible();
	await picker.getByRole('button', { name: 'Back to item' }).click();
	await expect(
		page.getByRole('dialog').getByRole('heading', { name: 'From heartbeat' })
	).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Discuss', exact: true }).click();
	await picker.getByRole('button', { name: 'Main chat', exact: true }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
		/^> From heartbeat:/
	);
});
