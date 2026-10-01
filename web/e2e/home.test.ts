import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { axe, horizontalOverflow, push, smallTargets, stubStream } from './helpers';

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

/** The app on fixtures: Home's server part from its fake, the stream and chat routes mocked here. */
async function homeServer(
	context: BrowserContext,
	opts: {
		pending?: { approvals: unknown[]; asks: unknown[] };
		fixtures?: string;
		streamStatus?: number;
		decide?: number;
	} = {}
) {
	const calls: Call[] = [];
	await stubStream(context);
	await context.addInitScript(
		({ pending, fixtures, streamStatus }) => {
			const w = window as unknown as {
				__sse: { hello: { pending: unknown }; status: number };
			};
			if (pending) w.__sse.hello.pending = pending;
			if (streamStatus) w.__sse.status = streamStatus;
			if (fixtures && !sessionStorage.getItem('fixtures-set')) {
				localStorage.setItem('fixtures:home', fixtures);
				sessionStorage.setItem('fixtures-set', '1');
			}
		},
		{ pending: opts.pending, fixtures: opts.fixtures, streamStatus: opts.streamStatus }
	);
	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const raw = req.postData();
		calls.push({ method: req.method(), path: url.pathname, body: raw ? JSON.parse(raw) : null });
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (url.pathname === '/api/me') return json({ login: 'drk@example.com' });
		if (url.pathname === '/api/chat/history') return json({ items: [], before: null });
		if (url.pathname.startsWith('/api/chat/approvals/')) {
			if (opts.decide && opts.decide !== 200) return json({ error: 'x' }, opts.decide);
			return json({ status: 'decided' });
		}
		if (url.pathname.startsWith('/api/chat/asks/')) return json({ status: 'answered' });
		if (url.pathname === '/api/chat/seen') return route.fulfill({ status: 204 });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	const posts = (prefix: string) =>
		calls.filter((c) => c.method === 'POST' && c.path.startsWith(prefix));
	return { calls, posts };
}

const busy = () => ({ approvals: [approval('n1')], asks: [ask('a1')] });
const sheet = (page: Page) => page.getByRole('dialog');

async function groupLabels(page: Page) {
	return page.locator('main h2').allTextContents();
}

test('groups what needs you in order and counts waiting items on the tab', async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy() });
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	expect((await groupLabels(page)).map((t) => t.replace(/\s+/g, ' ').trim())).toEqual([
		'Waiting on you 2',
		'Failed 2',
		'Running 1',
		'Ready for review 2'
	]);
	const homeTab = page
		.getByRole('navigation', { name: 'Main' })
		.getByRole('link', { name: /Home/ });
	await expect(homeTab).toContainText('2 waiting');
	await expect(homeTab).toHaveAttribute('aria-current', 'page');
	await push(page, 'approval_resolved', { nonce: 'n1', decision: 'approve' }, 5);
	await expect(homeTab).toContainText('1 waiting');
	await expect(page.getByText('Approve send_email')).toBeHidden();
});

test('a quiet day says nothing needs you, with a way into the chat', async ({ page, context }) => {
	await homeServer(context, { fixtures: 'empty' });
	await page.goto('/');
	await expect(page.getByText('Nothing needs you')).toBeVisible();
	await page.getByRole('button', { name: 'Open chat' }).click();
	await expect(page).toHaveURL(/\/chat$/);
});

test('a slow server shows a labelled skeleton, never a blank screen', async ({ page, context }) => {
	await homeServer(context, { fixtures: 'slow', streamStatus: 503 });
	await page.goto('/');
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
	await page.goto('/');
	await expect(page.getByText('Approve send_email')).toBeVisible();
	await expect(page.getByText('Loading failed and running work…')).toBeVisible();
	await expect(page.getByText('nightly-sync failed')).toBeVisible({ timeout: 6000 });
});

test('a failed server part keeps approvals on screen and retries', async ({ page, context }) => {
	await homeServer(context, { pending: busy(), fixtures: 'error' });
	await page.goto('/');
	await expect(page.getByText('Approve send_email')).toBeVisible();
	const alert = page
		.getByRole('alert')
		.filter({ hasText: "Couldn't load failed and running work" });
	await expect(alert).toBeVisible();
	await page.evaluate(() => localStorage.removeItem('fixtures:home'));
	await alert.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
	await expect(alert).toBeHidden();
});

test('a server error with nothing loaded shows an error and Retry', async ({ page, context }) => {
	await homeServer(context, { fixtures: 'error', streamStatus: 503 });
	await page.goto('/');
	await expect(page.getByText("Couldn't load Home.")).toBeVisible();
	await page.evaluate(() => localStorage.removeItem('fixtures:home'));
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('nightly-sync failed')).toBeVisible();
});

test('an unreachable agent says running work may be missing', async ({ page, context }) => {
	await homeServer(context, { pending: busy(), fixtures: 'offline' });
	await page.goto('/');
	await expect(
		page.getByText("Can't reach the agent, so running and failed work may be missing.")
	).toBeVisible();
	await expect(page.getByText('Approve send_email')).toBeVisible();
});

test('going offline shows the banner and keeps what was loaded', async ({ page, context }) => {
	await homeServer(context, { pending: busy() });
	await page.goto('/');
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
	await page.goto('/');
	await page.getByRole('button', { name: /Approve send_email/ }).click();
	const dialog = sheet(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading', { name: 'Approval needed' })).toBeVisible();
	const approve = dialog.getByRole('button', { name: 'Approve send_email' });
	await expect(approve).toBeDisabled();
	await expect(approve).toBeEnabled({ timeout: 2000 });
	await page.goBack();
	await expect(dialog).toBeHidden();
	await expect(page).toHaveURL(/\/$/);
	expect(posts('/api/chat/approvals/')).toEqual([]);
});

test('approving from the sheet posts the decision and says what happened', async ({
	page,
	context
}) => {
	const { posts } = await homeServer(context, { pending: busy() });
	await page.goto('/');
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
	await page.goto('/');
	await page.getByRole('button', { name: /Approve send_email/ }).click();
	await sheet(page).getByRole('button', { name: 'Deny send_email' }).click();
	await expect(sheet(page).getByRole('alert')).toHaveText(
		"The agent couldn't take your decision. Try again."
	);
	await expect(sheet(page).getByRole('button', { name: 'Deny send_email' })).toBeVisible();
});

test('a question answers from the sheet with the ask card', async ({ page, context }) => {
	const { posts } = await homeServer(context, { pending: busy() });
	await page.goto('/');
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
	await page.goto('/');
	await page.getByRole('button', { name: /nightly-sync failed/ }).click();
	await expect(sheet(page).getByText('rsync: connection to backup.lan timed out')).toBeVisible();
	await expect(sheet(page).getByRole('button', { name: 'Open run' })).toBeVisible();
	await sheet(page).getByRole('button', { name: 'Dismiss' }).click();
	await expect(sheet(page)).toBeHidden();
	await expect(page.getByText('nightly-sync failed')).toBeHidden();
});

test('Ask the agent opens the chat with the alert quoted in the composer', async ({
	page,
	context
}) => {
	await homeServer(context);
	await page.goto('/');
	await page.getByRole('button', { name: /nightly-sync failed/ }).click();
	await sheet(page).getByRole('button', { name: 'Ask the agent' }).click();
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
		/^> Scheduled job nightly-sync failed\n> rsync/
	);
	await page.goBack();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
	await expect(sheet(page)).toBeHidden();
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
		await expect(page).toHaveURL(/\/$/);
	});
}

test('a cold link to something already handled says so instead of waiting', async ({
	page,
	context
}) => {
	await homeServer(context, { pending: busy() });
	await page.goto('/?approve=gone');
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
	await page.goto('/?ask=a1');
	await expect(sheet(page).getByText("can't be checked right now")).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Home and its sheets pass axe, 48px targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await homeServer(context, { pending: busy() });
		await page.goto('/');
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
			await page.waitForTimeout(300);
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
