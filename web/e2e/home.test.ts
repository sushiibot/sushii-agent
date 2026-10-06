import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fakeBackend, type Scenario } from './fake-backend';
import {
	expandConversationInboxes,
	axe,
	horizontalOverflow,
	push,
	smallTargets,
	stubStream,
	openDrawer
} from './helpers';

type Call = { method: string; path: string; body: unknown };

const approval = (nonce: string, tool = 'send_email') => ({
	seq: 3,
	at: new Date(Date.now() - 3 * 60_000).toISOString(),
	nonce,
	view: {
		tool,
		agentId: 'main',
		agentName: 'sushii-agent',
		fields: [{ key: 'to', value: 'sam@example.com', kind: 'single', max: 200 }]
	}
});
const ask = (askId: string) => ({
	seq: 4,
	at: new Date(Date.now() - 10 * 60_000).toISOString(),
	key: `o-${askId}`,
	askId,
	question: 'Which day works for the car service?',
	choices: ['Friday', 'Saturday']
});

/** The app on fixtures: Home's server part from the fake backend, the stream and chat mocked here. */
async function homeServer(
	context: BrowserContext,
	opts: {
		pending?: { approvals: unknown[]; asks: unknown[] };
		fixtures?: Scenario;
		streamStatus?: number;
		decide?: number;
	} = {}
) {
	await expandConversationInboxes(context);
	const calls: Call[] = [];
	await stubStream(context);
	await context.addInitScript(
		({ pending, streamStatus }) => {
			const w = window as unknown as {
				__sse: { hello: { pending: unknown }; status: number };
			};
			if (pending) w.__sse.hello.pending = pending;
			if (streamStatus) w.__sse.status = streamStatus;
		},
		{ pending: opts.pending, streamStatus: opts.streamStatus }
	);
	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const raw = req.postData();
		calls.push({ method: req.method(), path: url.pathname, body: raw ? JSON.parse(raw) : null });
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (url.pathname === '/api/chat/history') return json({ items: [], before: null });
		if (url.pathname.startsWith('/api/chat/approvals/')) {
			if (opts.decide && opts.decide !== 200) return json({ error: 'x' }, opts.decide);
			return json({ status: 'decided' });
		}
		if (url.pathname.startsWith('/api/chat/asks/')) return json({ status: 'answered' });
		if (url.pathname === '/api/chat/seen') return route.fulfill({ status: 204 });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	const backend = await fakeBackend(context, { home: opts.fixtures });
	const posts = (prefix: string) =>
		[...calls, ...backend.calls].filter((c) => c.method === 'POST' && c.path.startsWith(prefix));
	return { calls, posts, backend };
}

const busy = () => ({ approvals: [approval('n1')], asks: [ask('a1')] });
const sheet = (page: Page) => page.getByRole('dialog');

test('groups what needs you in order and counts waiting items on the menu', async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy() });
	await page.goto('/inbox');
	await expect(page.getByRole('heading', { name: 'Conversations', level: 1 })).toBeVisible();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Needs you', exact: true })).toContainText(
		'Approve send_email'
	);
	await expect(page.getByRole('region', { name: 'Needs you', exact: true })).toContainText(
		'Which day works'
	);
	await expect(page.locator('details[data-inbox="main"]')).toContainText('nightly-sync failed');
	await expect(page.locator('details[data-inbox="other-activity"]')).toContainText(
		'Compare flight prices'
	);
	const menu = page.getByRole('button', { name: /^Menu/ });
	await expect(menu).toHaveAccessibleName('Menu, 4 need you');
	await menu.click();
	const inboxLink = page
		.getByRole('dialog', { name: 'Menu' })
		.getByRole('link', { name: /Conversations/ });
	await expect(inboxLink).toContainText('4 need you');
	await expect(inboxLink).toHaveAttribute('aria-current', 'page');
	await page.keyboard.press('Escape');
	await push(page, 'approval_resolved', { nonce: 'n1', decision: 'approve' }, 5);
	await expect(menu).toHaveAccessibleName('Menu, 3 need you');
	await expect(page.getByText('Approve send_email')).toBeHidden();
});

test('a quiet day says nothing needs you, with a way into the chat', async ({ page, context }) => {
	await homeServer(context, { fixtures: 'empty' });
	await page.goto('/inbox');
	await expect(page.getByText('Nothing needs you')).toBeVisible();
	await page.getByRole('link', { name: /^Main chat/ }).click();
	await expect(page).toHaveURL(/\/chat$/);
});

test('a slow server shows a labelled skeleton, never a blank screen', async ({ page, context }) => {
	await homeServer(context, { fixtures: 'slow', streamStatus: 503 });
	await page.goto('/inbox');
	await expect(
		page.getByRole('status').filter({ hasText: 'Loading what needs you' })
	).toBeAttached();
	await expect(page.getByText('nightly-sync failed')).toBeVisible({ timeout: 6000 });
});

test('a slow server part keeps the waiting items and says what is still loading', async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy(), fixtures: 'slow' });
	await page.goto('/inbox');
	await expect(page.getByText('Approve send_email')).toBeVisible();
	await expect(page.getByText('Loading failed and running work…')).toBeVisible();
	await expect(page.getByText('nightly-sync failed')).toBeVisible({ timeout: 6000 });
});

test('a failed server part keeps approvals on screen and retries', async ({ page, context }) => {
	const { backend } = await homeServer(context, { pending: busy(), fixtures: 'error' });
	await page.goto('/inbox');
	await expect(page.getByText('Approve send_email')).toBeVisible();
	const alert = page
		.getByRole('alert')
		.filter({ hasText: "Couldn't load failed and running work" });
	await expect(alert).toBeVisible();
	backend.set('home', 'normal');
	await alert.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	await expect(alert).toBeHidden();
});

test('a server error with nothing loaded shows an error and Retry', async ({ page, context }) => {
	const { backend } = await homeServer(context, { fixtures: 'error', streamStatus: 503 });
	await page.goto('/inbox');
	await expect(page.getByText("Couldn't load your inbox.")).toBeVisible();
	backend.set('home', 'normal');
	await page
		.getByLabel('Inbox for Main chat', { exact: true })
		.getByRole('button', { name: 'Try again' })
		.click();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
});

test('an unreachable agent says running work may be missing', async ({ page, context }) => {
	await homeServer(context, { pending: busy(), fixtures: 'offline' });
	await page.goto('/inbox');
	await expect(
		page.getByText("Can't reach the agent, so running and failed work may be missing.")
	).toBeVisible();
	await expect(page.getByText('Approve send_email')).toBeVisible();
});

test('going offline shows the banner and keeps what was loaded', async ({ page, context }) => {
	await homeServer(context, { pending: busy() });
	await page.goto('/inbox');
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	await context.setOffline(true);
	await expect(page.getByText(/offline/i).first()).toBeVisible();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	await context.setOffline(false);
});

test('an approval peeks in a sheet with the real tray, held for a moment, and back closes it', async ({
	page,
	context
}) => {
	const { posts } = await homeServer(context, { pending: busy() });
	await page.goto('/inbox');
	await page.getByRole('button', { name: /Approve send_email/ }).click();
	const dialog = sheet(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Approval needed' })).toBeVisible();
	const approve = dialog.getByRole('button', { name: 'Approve send_email' });
	await expect(approve).toBeDisabled();
	await expect(approve).toBeEnabled({ timeout: 2000 });
	await page.goBack();
	await expect(dialog).toBeHidden();
	await expect(page).toHaveURL(/\/chats$/);
	expect(posts('/api/chat/approvals/')).toEqual([]);
});

test('approving from the sheet posts the decision and says what happened', async ({
	page,
	context
}) => {
	const { posts } = await homeServer(context, { pending: busy() });
	await page.goto('/inbox');
	await page.getByRole('button', { name: /Approve send_email/ }).click();
	const approve = sheet(page).getByRole('button', { name: 'Approve send_email' });
	await expect(approve).toBeEnabled({ timeout: 2000 });
	await approve.click();
	await expect
		.poll(() => posts('/api/chat/approvals/n1').map((c) => c.body))
		.toEqual([{ decision: 'approve' }]);
	await expect(sheet(page).getByText('Approved. The agent carries on.')).toBeVisible();
	await push(page, 'approval_resolved', { nonce: 'n1', decision: 'approve' }, 5);
	await expect(sheet(page).getByText('Approved. The agent carries on.')).toBeVisible();
	await sheet(page).getByRole('button', { name: 'Close' }).click();
	await expect(sheet(page)).toBeHidden();
	await expect(page.getByText('Approve send_email')).toBeHidden();
});

test('a decision that fails to send says so in the sheet and can be tried again', async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy(), decide: 500 });
	await page.goto('/inbox');
	await page.getByRole('button', { name: /Approve send_email/ }).click();
	await sheet(page).getByRole('button', { name: 'Deny send_email' }).click();
	await expect(sheet(page).getByRole('alert')).toHaveText(
		"The agent couldn't take your decision. Try again."
	);
	await expect(sheet(page).getByRole('button', { name: 'Deny send_email' })).toBeVisible();
});

test('a question answers from the sheet with the ask card', async ({ page, context }) => {
	const { posts } = await homeServer(context, { pending: busy() });
	await page.goto('/inbox');
	await page.getByRole('button', { name: /Which day works/ }).click();
	await sheet(page).getByRole('button', { name: 'Saturday' }).click();
	await expect
		.poll(() => posts('/api/chat/asks/a1').map((c) => c.body))
		.toEqual([{ index: 1, label: 'Saturday' }]);
	await expect(sheet(page).getByText('Sent. The agent has your answer.')).toBeVisible();
});

test('a failed job peeks with its error, and Dismiss takes it off Home', async ({
	page,
	context
}) => {
	await homeServer(context);
	await page.goto('/inbox');
	await page.getByRole('button', { name: /nightly-sync failed/ }).click();
	await expect(sheet(page).getByText('rsync: connection to backup.lan timed out')).toBeVisible();
	await expect(sheet(page).getByRole('button', { name: 'View activity' })).toBeVisible();
	await sheet(page).getByRole('button', { name: 'Dismiss' }).click();
	await expect(sheet(page)).toBeHidden();
	await expect(page.getByText('nightly-sync failed')).toBeHidden();
});

test('Ask the agent steps back to the chat under the inbox, with the alert quoted', async ({
	page,
	context
}) => {
	await homeServer(context);
	await page.goto('/chat');
	await (await openDrawer(page)).getByRole('link', { name: 'Conversations' }).click();
	await page.getByRole('button', { name: /nightly-sync failed/ }).click();
	await sheet(page).getByRole('button', { name: 'Ask the agent' }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
		/^> Scheduled job nightly-sync failed\n> rsync/
	);
	await page.goForward();
	await expect(page).toHaveURL(/\/chats$/);
	await expect(sheet(page)).toBeHidden();
});

test('from a cold inbox link, Ask the agent opens the chat in place of the inbox', async ({
	page,
	context
}) => {
	await homeServer(context);
	await page.goto('/inbox');
	await page.getByRole('button', { name: /nightly-sync failed/ }).click();
	await sheet(page).getByRole('button', { name: 'Ask the agent' }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await page.goBack();
	await expect(page).not.toHaveURL(/\/(inbox|chat)/);
});

for (const [link, item, text] of [
	['/?approve=n1', 'approval', 'Approval needed'],
	['/?ask=a1', 'ask', 'Which day works for the car service?'],
	['/home?item=job%3Anightly-sync', 'job alert', 'rsync: connection to backup.lan']
] as const) {
	test(`a cold push link to an ${item} opens it on Home (${link})`, async ({ page, context }) => {
		await homeServer(context, { pending: busy() });
		await page.goto(link);
		await expect(sheet(page)).toBeVisible();
		await expect(sheet(page).getByText(text).first()).toBeVisible();
		await expect(page).toHaveURL(/\/chats$/);
	});
}

test('a cold link to something already handled says so instead of waiting', async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy() });
	await page.goto('/inbox?approve=gone');
	await expect(sheet(page).getByRole('heading', { name: 'Already handled' })).toBeVisible();
	await expect(sheet(page).getByText("This isn't waiting any more.")).toBeVisible();
	await sheet(page).getByRole('button', { name: 'Close' }).click();
	await expect(sheet(page)).toBeHidden();
	await page.reload();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	await expect(sheet(page)).toBeHidden();
});

test('a cold link with the stream refused says it cannot check, without spinning', async ({
	page,
	context
}) => {
	await homeServer(context, { streamStatus: 403 });
	await page.goto('/inbox?ask=a1');
	await expect(sheet(page).getByRole('heading', { name: "Can't check this now" })).toBeVisible();
	await expect(sheet(page).getByText("can't be checked right now")).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Home and its sheets pass axe, 48px targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		// Inspect settled colors; sheet-motion.test.ts covers animated opening and dismissal.
		await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
		await homeServer(context, { pending: busy() });
		await page.goto('/inbox');
		await expect(page.getByText('nightly-sync failed')).toBeVisible();
		expect(await axe(page)).toEqual([]);
		expect(await smallTargets(page)).toEqual([]);
		for (const name of [
			/Approve send_email/,
			/Which day works/,
			/nightly-sync failed/,
			/Compare flight/,
			/Main chat/
		]) {
			const row = page.getByRole('button', { name }).first();
			if (!(await row.count())) continue;
			await row.click();
			await expect(sheet(page)).toBeVisible();
			expect(await axe(page), String(name)).toEqual([]);
			expect(await smallTargets(page), String(name)).toEqual([]);
			await page.goBack();
			await expect(sheet(page)).toBeHidden();
		}
		for (const width of [412, 320]) {
			await page.setViewportSize({ width, height: 800 });
			expect(await horizontalOverflow(page), `overflow at ${width}px`).toEqual([]);
		}
	});
}

test('an alert or run event refetches Home, so a new failure shows without a reload', async ({
	page,
	context
}) => {
	const { backend } = await homeServer(context, { fixtures: 'empty' });
	await page.goto('/inbox');
	await expect(page.getByText('Nothing needs you')).toBeVisible();
	const loads = () => backend.calls.filter((c) => c.method === 'GET' && c.path === '/api/home');
	const before = loads().length;
	backend.set('home', 'normal');
	await push(
		page,
		'alert',
		{
			key: 'o1',
			text: 'nightly-sync failed',
			alert: {
				source: 'job',
				job: 'nightly-sync',
				kind: 'failed',
				trigger: 'daily',
				startedAt: new Date().toISOString(),
				schedule: 'daily 02:00'
			}
		},
		9
	);
	await push(page, 'run', {
		runId: '01K6B4D2F4H6K8M0P2R4T6V8X0',
		kind: 'subagent',
		status: 'running'
	});
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	expect(loads().length).toBe(before + 1);
	await push(page, 'alert_cleared', { id: 'job:nightly-sync', reason: 'recovered' }, 10);
	await expect(page.getByText('nightly-sync failed')).toBeHidden();
});

test("an agent answer outside the contract says Home's running work couldn't be read", async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy(), fixtures: 'bad' });
	await page.goto('/inbox');
	await expect(
		page.getByText("The agent's list of running and failed work couldn't be read")
	).toBeVisible();
	await expect(page.getByText('Approve send_email')).toBeVisible();
});

test('a cold link to a job alert that has cleared says Already handled', async ({
	page,
	context
}) => {
	await homeServer(context, { fixtures: 'empty' });
	await page.goto('/inbox?item=job%3Anightly-sync');
	await expect(sheet(page).getByRole('heading', { name: 'Already handled' })).toBeVisible();
	await expect(page).toHaveURL(/\/chats$/);
});

test('opening a run tells the bot once, and it stays in the inbox as read on every device', async ({
	page,
	context
}) => {
	const { backend } = await homeServer(context);
	await page.goto('/inbox');
	await page.getByRole('button', { name: /Draft the quarterly expenses summary/ }).click();
	await sheet(page).getByRole('button', { name: 'View activity' }).click();
	await expect(page).toHaveURL(/\/runs\//);
	await expect
		.poll(() => backend.calls.filter((c) => c.path === '/api/home/opened').map((c) => c.body))
		.toEqual([{ id: 'run:01K6B3A1C3E5G7J9M1P3R5T7V9' }]);
	await page.reload();
	await page.goto('/inbox');
	await expect(
		page.getByRole('button', { name: /Read: Draft the quarterly expenses summary/ })
	).toBeVisible();
	await expect(page.getByRole('button', { name: /Your passport renewal/ })).not.toContainText(
		'Read:'
	);
});

test("a job's message opens in full, Reply quotes it into the chat, and it stays read", async ({
	page,
	context
}) => {
	const { backend } = await homeServer(context);
	await page.goto('/inbox');
	await page.getByRole('button', { name: /Your passport renewal is due Friday/ }).click();
	await expect(sheet(page).getByRole('heading', { name: 'From heartbeat' })).toBeVisible();
	await expect(sheet(page).locator('strong', { hasText: 'Friday' })).toBeVisible();
	await expect
		.poll(() => backend.calls.filter((c) => c.path === '/api/home/opened').map((c) => c.body))
		.toEqual([{ id: 'msg:ob-heartbeat-1' }]);
	await sheet(page).getByRole('button', { name: 'Reply in chat' }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('textbox')).toHaveValue(
		/^> From heartbeat:\n> Your passport renewal is due \*\*Friday\*\*/
	);
	await (await openDrawer(page)).getByRole('link', { name: 'Conversations' }).click();
	await expect(page.getByRole('button', { name: /Read: Your passport renewal/ })).toBeVisible();
});

test('Done takes an item off Home on every device, and Undo brings it back', async ({
	page,
	context
}) => {
	const { backend } = await homeServer(context);
	await page.goto('/inbox');
	await page.getByRole('button', { name: /Your passport renewal/ }).click();
	await sheet(page).getByRole('button', { name: 'Done' }).click();
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(page.getByRole('button', { name: /Your passport renewal/ })).toBeHidden();
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByRole('button', { name: /Your passport renewal/ })).toBeVisible();
	await expect
		.poll(() => backend.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]))
		.toEqual([
			['/api/home/opened', { id: 'msg:ob-heartbeat-1' }],
			['/api/home/dismiss', { id: 'msg:ob-heartbeat-1' }],
			['/api/home/restore', { id: 'msg:ob-heartbeat-1' }]
		]);
	await page.getByRole('button', { name: /Draft the quarterly expenses summary/ }).click();
	await sheet(page).getByRole('button', { name: 'Done' }).click();
	await page.reload();
	await expect(page.getByRole('button', { name: /Your passport renewal/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /Draft the quarterly expenses/ })).toBeHidden();
});

test('swiping an inbox row sideways marks it done', async ({ page, context }) => {
	const { backend } = await homeServer(context);
	await page.goto('/inbox');
	const row = page.getByRole('button', { name: /Your passport renewal/ });
	const box = (await row.boundingBox())!;
	const y = box.y + box.height / 2;
	const touch = { pointerType: 'touch', isPrimary: true, pointerId: 7 };
	// A short swipe snaps back and doesn't eat the next tap.
	await row.dispatchEvent('pointerdown', { ...touch, clientX: box.x + 200, clientY: y });
	await row.dispatchEvent('pointermove', { ...touch, clientX: box.x + 170, clientY: y });
	await row.dispatchEvent('pointerup', { ...touch, clientX: box.x + 170, clientY: y });
	await row.click();
	await expect(sheet(page).getByRole('heading', { name: 'From heartbeat' })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole('dialog')).toBeHidden();
	await row.dispatchEvent('pointerdown', { ...touch, clientX: box.x + box.width - 20, clientY: y });
	for (const dx of [20, 60, 120, 200, 260]) {
		await row.dispatchEvent('pointermove', {
			...touch,
			clientX: box.x + box.width - 20 - dx,
			clientY: y
		});
	}
	await row.dispatchEvent('pointerup', { ...touch, clientX: box.x + 20, clientY: y });
	await expect(row).toBeHidden();
	await expect(page.getByRole('dialog')).toBeHidden();
	expect(backend.calls.filter((c) => c.path === '/api/home/dismiss').map((c) => c.body)).toEqual([
		{ id: 'msg:ob-heartbeat-1' }
	]);
});

test("a job message's push opens it on Home", async ({ page, context }) => {
	await homeServer(context);
	await page.goto('/inbox?item=msg%3Aob-heartbeat-1');
	await expect(sheet(page).getByRole('heading', { name: 'From heartbeat' })).toBeVisible();
});

test('a dismissed job is posted once and stays off Home after a reload', async ({
	page,
	context
}) => {
	const { backend } = await homeServer(context);
	await page.goto('/inbox');
	await page.getByRole('button', { name: /nightly-sync failed/ }).click();
	await sheet(page).getByRole('button', { name: 'Dismiss' }).click();
	await expect(page.getByText('nightly-sync failed')).toBeHidden();
	expect(backend.calls.filter((c) => c.path === '/api/home/dismiss').map((c) => c.body)).toEqual([
		{ id: 'job:nightly-sync' }
	]);
	await page.reload();
	await expect(page.getByRole('button', { name: /Your passport renewal/ })).toBeVisible();
	await expect(page.getByText('nightly-sync failed')).toBeHidden();
});

test("a cold link to a job when Home's server part fails says it can't check, not handled", async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy(), fixtures: 'error' });
	await page.goto('/inbox?item=job%3Anightly-sync');
	await expect(sheet(page).getByRole('heading', { name: "Can't check this now" })).toBeVisible();
});

test("a cold link to a run while the agent is unreachable says it can't check", async ({
	page,
	context
}) => {
	await homeServer(context, { fixtures: 'offline' });
	await page.goto('/inbox?item=run%3A01K6B3A1C3E5G7J9M1P3R5T7V9');
	await expect(sheet(page).getByRole('heading', { name: "Can't check this now" })).toBeVisible();
});

test('launched on the chat, the menu already flags what waits and what failed', async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy() });
	await page.goto('/');
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('button', { name: /^Menu/ })).toHaveAccessibleName(
		'Menu, 4 need you'
	);
});
