import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
	axe,
	endStreams,
	horizontalOverflow,
	push,
	smallTargets,
	streamRequests,
	stubStream,
	openDrawer
} from './helpers';

const CLIENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UPLOAD_ID = 'AbCdEfGhIjKlMnOpQrStUv';

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
type Opts = {
	historyStatus: number;
	history: unknown[];
	before: string | null;
	messageStatus: number | 'abort';
	messageBody: Record<string, unknown>;
	approvalStatus: number;
	askStatus: number;
	uploadStatus: number;
	discardStatus: number;
	/** When set, message POSTs and uploads are held until it settles. */
	messageGate?: Promise<void>;
	uploadGate?: Promise<void>;
	/** Older pages by the `before` cursor they answer. */
	older: Record<string, OlderPage>;
};
type OlderPage = {
	status: number;
	items?: unknown[];
	before?: string | null;
	/** Held until this settles, so a test can look at the list between pages. */
	gate?: Promise<void>;
	onServe?: () => void;
};

const errorBody = () => ({ error: 'x' });

async function chatServer(context: BrowserContext, initial: Partial<Opts> = {}) {
	const opts: Opts = {
		historyStatus: 200,
		history: [],
		before: null,
		messageStatus: 202,
		messageBody: { seq: 1 },
		approvalStatus: 200,
		askStatus: 200,
		uploadStatus: 200,
		discardStatus: 200,
		older: {},
		...initial
	};
	const calls: Call[] = [];
	await stubStream(context);
	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname;
		let body: unknown = null;
		const raw = req.postData();
		if (raw && req.headers()['content-type']?.includes('json')) body = JSON.parse(raw);
		calls.push({ method: req.method(), path: path + url.search, body, headers: req.headers() });
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (path === '/api/me')
			return json({ login: 'drk@example.com', features: ['runs', 'history', 'home', 'alerts'] });
		if (path === '/api/push/key') return route.fulfill({ status: 404, body: 'no' });
		if (path === '/api/models')
			return json({
				current: 'sol',
				models: [{ alias: 'sol', backend: 'chatgpt', id: 'gpt-6.1-sol' }]
			});
		if (path === '/api/chat/history' && url.searchParams.has('before')) {
			const o = opts.older[url.searchParams.get('before')!] ?? { status: 200 };
			await o.gate;
			o.onServe?.();
			if (o.status !== 200) return json(errorBody(), o.status);
			return json({ items: o.items ?? [], before: o.before ?? null });
		}
		if (path === '/api/chat/history') {
			if (opts.historyStatus !== 200) return json(errorBody(), opts.historyStatus);
			return json({ items: opts.history, before: opts.before });
		}
		if (path.startsWith('/api/chat/messages/') && req.method() === 'DELETE') {
			const body = { 200: { discarded: true }, 409: { routed: true } }[opts.discardStatus] ?? {
				error: 'x'
			};
			return json(body, opts.discardStatus);
		}
		if (path === '/api/chat/messages') {
			await opts.messageGate;
			if (opts.messageStatus === 'abort') return route.abort('internetdisconnected');
			if (opts.messageStatus === 409)
				return json({ error: 'upload_missing', ids: [UPLOAD_ID] }, 409);
			if (opts.messageStatus !== 202) return json({ error: 'bad' }, opts.messageStatus);
			return json(opts.messageBody, 202);
		}
		if (path === '/api/chat/stop' || path === '/api/chat/command') return json({}, 202);
		if (path.startsWith('/api/chat/asks/')) {
			if (opts.askStatus !== 200) return json({ error: 'no' }, opts.askStatus);
			return json({ status: 'answered' });
		}
		if (path.startsWith('/api/chat/approvals/') || path.startsWith('/api/chat/location/')) {
			if (opts.approvalStatus !== 200) return json({ error: 'no' }, opts.approvalStatus);
			return json({ status: 'decided' });
		}
		if (path === '/api/chat/seen') return route.fulfill({ status: 204 });
		if (path === '/api/uploads') {
			await opts.uploadGate;
			if (opts.uploadStatus !== 200) return json({ error: 'no' }, opts.uploadStatus);
			return json({ id: UPLOAD_ID, contentType: 'image/jpeg', bytes: 1234 });
		}
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	const posts = (p: string) => calls.filter((c) => c.method === 'POST' && c.path.startsWith(p));
	return { calls, opts, posts };
}

async function open(page: Page) {
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
}

async function type(page: Page, text: string) {
	await page.getByRole('textbox', { name: 'Message' }).fill(text);
	await page.getByRole('button', { name: 'Send message' }).click();
}

const bubble = (page: Page, text: string) =>
	page.locator('[data-message-id]').filter({ hasText: text });

test('a send shows at once, carries a ULID, and settles on the status event', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await open(page);
	await expect(page.getByText('Say hi to your agent.')).toBeVisible();
	await type(page, 'Book the car service');
	await expect(bubble(page, 'Book the car service')).toBeVisible();
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	const body = posts('/api/chat/messages')[0].body as { clientId: string; text: string };
	expect(body.text).toBe('Book the car service');
	expect(body.clientId).toMatch(CLIENT_ID);
	await expect(bubble(page, 'Book the car service')).toContainText('Sending');

	await push(page, 'user', { key: body.clientId, text: body.text, uploadIds: [], at: 'x' }, 1);
	await push(page, 'status', { clientId: body.clientId, state: 'accepted' }, 2);
	await expect(bubble(page, 'Book the car service')).toContainText('Sent');
	await expect(page.locator('[data-message-id]').filter({ hasText: 'Book' })).toHaveCount(1);
	// The status names the actual model state.
	await expect(page.locator('[data-typing] [aria-hidden=true]')).toContainText(/\S.*…/);
	await expect(page.locator('[data-typing]')).not.toContainText('Sushii');

	await push(page, 'tool', { turnId: 't1', name: 'search_mail', summary: 'Searching mail' });
	await expect(page.getByText('Searching mail').first()).toBeVisible();
	await push(page, 'delta', { turnId: 't1', offset: 0, text: 'Booked for ' });
	await push(page, 'delta', { turnId: 't1', offset: 11, text: 'Saturday.' });
	// An out-of-order delta waits for a snapshot instead of corrupting the text.
	await push(page, 'delta', { turnId: 't1', offset: 3, text: 'XX' });
	await expect(page.getByText('Booked for Saturday.')).toBeVisible();
	await push(
		page,
		'reply',
		{ key: 'o1', turnId: 't1', text: 'Booked for Saturday 09:00.', files: [] },
		3
	);
	await push(
		page,
		'turn_final',
		{ turnId: 't1', outcome: 'done', summary: { durationMs: 12000, toolCount: 1 } },
		4
	);
	await expect(page.getByText('Booked for Saturday 09:00.')).toBeVisible();
	await expect(page.getByText('Booked for Saturday.', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Searching mail').first()).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'Agent replied' })).toBeAttached();
	await expect.poll(() => posts('/api/chat/seen').at(-1)?.body).toEqual({ seq: 4 });
});

test('a rejected send stays with Retry and Delete, and Retry reuses the client id', async ({
	page,
	context
}) => {
	const { posts, opts, calls } = await chatServer(context, { messageStatus: 400 });
	await open(page);
	await type(page, 'This one fails');
	await expect(bubble(page, 'This one fails')).toContainText('Failed');
	opts.messageStatus = 202;
	await page.getByRole('button', { name: 'Retry send' }).click();
	await expect.poll(() => posts('/api/chat/messages').length).toBe(2);
	const [a, b] = posts('/api/chat/messages').map((c) => (c.body as { clientId: string }).clientId);
	expect(a).toBe(b);

	opts.messageStatus = 400;
	opts.discardStatus = 404;
	await type(page, 'Delete me');
	await expect(bubble(page, 'Delete me')).toContainText('Failed');
	await bubble(page, 'Delete me').getByRole('button', { name: 'Delete' }).click();
	await expect(bubble(page, 'Delete me')).toHaveCount(0);
	// Its POST went out, so the bot is asked first; it never stored the message, so it goes locally.
	expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
});

test('offline sends queue, survive a reload, and go out with the same id', async ({
	page,
	context
}) => {
	const { posts, opts } = await chatServer(context, { messageStatus: 'abort' });
	await open(page);
	await context.setOffline(true);
	await expect(page.getByText('Offline. Messages send when you reconnect.')).toBeVisible();
	await type(page, 'Queued while offline');
	await expect(bubble(page, 'Queued while offline')).toContainText(
		"Queued, sends when you're back online"
	);
	await context.setOffline(false);
	await page.reload();
	await expect(bubble(page, 'Queued while offline')).toBeVisible();
	opts.messageStatus = 202;
	await page.evaluate(() => dispatchEvent(new Event('online')));
	await expect
		.poll(
			() =>
				new Set(posts('/api/chat/messages').map((c) => (c.body as { clientId: string }).clientId))
					.size
		)
		.toBe(1);
	await expect
		.poll(() => posts('/api/chat/messages').at(-1)?.body)
		.toMatchObject({
			text: 'Queued while offline'
		});
});

test('an offline workspace queues the message and re-sends it when the agent is back', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await open(page);
	await type(page, 'Are you there?');
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	await push(page, 'workspace', { state: 'offline' });
	await push(page, 'notice', { type: 'workspaceOffline' }, 1);
	await expect(
		page.getByText("The agent is offline. Your message is queued and sends when it's back.")
	).toBeVisible();
	await expect(bubble(page, 'Are you there?')).toContainText(
		'Queued, sends when the agent is back'
	);
	await push(page, 'workspace', { state: 'online' });
	await expect.poll(() => posts('/api/chat/messages').length).toBe(2);
	const ids = posts('/api/chat/messages').map((c) => (c.body as { clientId: string }).clientId);
	expect(ids[0]).toBe(ids[1]);
	await expect(page.getByText('The agent is offline.', { exact: false })).toBeHidden();
});

test('a dropped stream resumes from the last seq without duplicating anything', async ({
	page,
	context
}) => {
	await chatServer(context);
	await open(page);
	await push(page, 'proactive', { key: 'p1', text: 'Rent receipt filed', files: [] }, 5);
	await expect(page.getByText('Rent receipt filed')).toBeVisible();
	await endStreams(page);
	await expect.poll(() => streamRequests(page)).toContain('/api/chat/stream?after=5');
	await push(page, 'proactive', { key: 'p1', text: 'Rent receipt filed', files: [] }, 5);
	await push(page, 'proactive', { key: 'p2', text: 'Sweep failed', files: [] }, 6);
	await expect(page.getByText('Sweep failed')).toBeVisible();
	await expect(page.getByText('Rent receipt filed')).toHaveCount(1);
});

test('a reset reloads history and says so', async ({ page, context }) => {
	const { calls, opts } = await chatServer(context);
	await open(page);
	opts.history = [
		{
			type: 'assistant',
			id: 'a1',
			at: 'x',
			text: 'From the reloaded history',
			tools: [],
			files: []
		}
	];
	await push(page, 'reset', {
		headSeq: 40,
		workspace: 'online',
		pending: { approvals: [], asks: [] }
	});
	await expect(page.getByText('Reloaded the conversation.', { exact: false })).toBeVisible();
	await expect(page.getByText('From the reloaded history')).toBeVisible();
	expect(calls.filter((c) => c.path.startsWith('/api/chat/history')).length).toBe(2);
});

test('history that is unavailable offers a retry', async ({ page, context }) => {
	const { opts } = await chatServer(context, { historyStatus: 503 });
	await open(page);
	await expect(page.getByText('Earlier messages unavailable right now')).toBeVisible();
	opts.historyStatus = 200;
	opts.history = [
		{ type: 'user', id: 'u1', at: 'x', text: 'Old owner message', attachments: [] },
		{
			type: 'user',
			id: 'u2',
			at: 'x',
			text: 'Only in the transcript',
			attachments: []
		}
	];
	await page.getByRole('button', { name: 'Retry' }).click();
	await expect(page.getByText('Old owner message')).toBeVisible();
	await expect(page.getByText('Only in the transcript')).toBeVisible();
	await expect(page.getByText('Earlier messages unavailable right now')).toBeHidden();
});

test('a history-only message looks like a live one but offers only the read actions', async ({
	page,
	context
}) => {
	await chatServer(context, {
		history: [
			{
				type: 'user',
				id: 'u1',
				at: 'x',
				text: 'From the transcript',
				attachments: []
			}
		],
		messageStatus: 400
	});
	await open(page);
	await type(page, 'Sent just now');
	await expect(bubble(page, 'Sent just now')).toContainText('Failed');
	const classes = (text: string) =>
		bubble(page, text).locator('[data-message-text]').getAttribute('class');
	expect(await classes('From the transcript')).toBe(await classes('Sent just now'));
	await expect(page.getByText(/workspace history/)).toHaveCount(0);

	const transcript = bubble(page, 'From the transcript');
	await expect(transcript.getByRole('button', { name: 'Copy' })).toBeVisible();
	await expect(transcript.getByRole('button', { name: /Retry|Delete|Approve|Deny/ })).toHaveCount(
		0
	);
});

test('older pages load above with the server cursor', async ({ page, context }) => {
	const { calls } = await chatServer(context, {
		history: [{ type: 'user', id: 'u5', at: 'x', text: 'Newest page', attachments: [] }],
		before: '5',
		older: {
			'5': {
				status: 200,
				items: [{ type: 'user', id: 'u1', at: 'x', text: 'Older page', attachments: [] }],
				before: null
			}
		}
	});
	await open(page);
	await expect(page.getByText('Older page')).toBeVisible();
	expect(calls.some((c) => c.path.includes('before=5'))).toBe(true);
	const order = await page.locator('[data-message-id]').allTextContents();
	expect(order.findIndex((t) => t.includes('Older page'))).toBeLessThan(
		order.findIndex((t) => t.includes('Newest page'))
	);
});

const approval = (nonce: string, tool = 'send_email') => ({
	nonce,
	view: {
		tool,
		agentId: 'main',
		agentName: 'Main',
		fields: [{ key: 'to', value: 'dana@example.com', kind: 'single', max: 200 }]
	}
});

test('an approval shows inline Approve/Deny and posts the decision', async ({ page, context }) => {
	const { posts } = await chatServer(context);
	await open(page);
	await push(page, 'snapshot', {
		turnId: 't1',
		view: { turnId: 't1', startedAt: Date.now(), lines: [], toolCount: 0, text: '' }
	});
	await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
	await push(page, 'approval', approval('n1'), 1);
	const approve = page.getByRole('button', { name: 'Approve send_email' });
	await expect(approve).toBeVisible();
	await expect(approve).toBeEnabled();
	await page.getByRole('button', { name: 'Deny send_email' }).click();
	await expect
		.poll(() => posts('/api/chat/approvals/n1').at(0)?.body)
		.toEqual({ decision: 'deny' });
	await push(page, 'approval_resolved', { nonce: 'n1', decision: 'deny' }, 2);
	await expect(approve).toBeHidden();
	await expect(
		page.locator('[data-tool-call] summary').getByText('Denied', { exact: true })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
});

test('an approval decided on another device and a timeout both say so', async ({
	page,
	context
}) => {
	await chatServer(context);
	await open(page);
	await push(page, 'approval', approval('n1'), 1);
	await push(page, 'approval_resolved', { nonce: 'n1', decision: 'approve' }, 2);
	await expect(
		page.locator('[data-tool-call] summary').getByText('Approved on another device')
	).toBeVisible();
	await push(page, 'approval', approval('n2', 'run_shell'), 3);
	await push(page, 'approval_resolved', { nonce: 'n2', decision: 'timeout' }, 4);
	await expect(
		page.locator('[data-tool-call] summary').getByText('Expired', { exact: true })
	).toBeVisible();
});

test('an ask answers with the chip index and label, and never looks like an approval', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await open(page);
	await push(
		page,
		'ask',
		{ key: 'o1', askId: 'k1', question: 'Which day?', choices: ['Friday', 'Saturday'] },
		1
	);
	await expect(page.getByText('The agent asks:')).toBeVisible();
	await expect(page.getByRole('button', { name: /approve/i })).toHaveCount(0);
	await page.getByRole('button', { name: 'Saturday' }).click();
	await expect
		.poll(() => posts('/api/chat/asks/k1').at(0)?.body)
		.toEqual({ index: 1, label: 'Saturday' });
	await push(page, 'ask_resolved', { askId: 'k1', answer: 'Saturday' }, 2);
	await expect(page.getByText('You answered:')).toBeVisible();
});

test('Stop posts the turn id and "Nothing to stop" shows as a toast', async ({ page, context }) => {
	const { posts } = await chatServer(context);
	await open(page);
	await push(page, 'tool', { turnId: 't9', name: 'fetch', summary: 'Opening the page' });
	await page.getByRole('button', { name: 'Stop' }).click();
	await expect.poll(() => posts('/api/chat/stop').at(0)?.body).toEqual({ turnId: 't9' });
	await expect(page.getByText('Stopping…').first()).toBeVisible();
	await push(page, 'notice', { type: 'nothingToStop' }, 1);
	await expect(page.getByText('Nothing to stop.')).toBeVisible();
});

test('a photo is re-encoded to JPEG, uploaded with a client id, and sent by id', async ({
	page,
	context
}) => {
	const { posts, calls } = await chatServer(context);
	await open(page);
	const png = await page.evaluate(async () => {
		const c = new OffscreenCanvas(40, 30);
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = 'red';
		ctx.fillRect(0, 0, 40, 30);
		const blob = await c.convertToBlob({ type: 'image/png' });
		return [...new Uint8Array(await blob.arrayBuffer())];
	});
	await page.locator('input[type=file]').setInputFiles({
		name: 'IMG_0001.png',
		mimeType: 'image/png',
		buffer: Buffer.from(png)
	});
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	const upload = calls.find((c) => c.path === '/api/uploads')!;
	expect(upload.headers['content-type']).toBe('image/jpeg');
	expect(upload.headers['x-upload-name']).toBe('IMG_0001.jpg');
	expect(upload.headers['x-client-id']).toMatch(CLIENT_ID);
	await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect
		.poll(() => posts('/api/chat/messages').at(0)?.body)
		.toMatchObject({
			text: '',
			uploadIds: [UPLOAD_ID]
		});
});

test('a full photo store blocks attaching and says why', async ({ page, context }) => {
	await chatServer(context, { uploadStatus: 507 });
	await open(page);
	const png = await page.evaluate(async () => {
		const c = new OffscreenCanvas(8, 8);
		c.getContext('2d')!.fillRect(0, 0, 8, 8);
		const blob = await c.convertToBlob({ type: 'image/png' });
		return [...new Uint8Array(await blob.arrayBuffer())];
	});
	await page
		.locator('input[type=file]')
		.setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(png) });
	await expect(page.getByText('Photo storage is full.', { exact: false })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Attach photos' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

async function attachPng(page: Page) {
	const png = await page.evaluate(async () => {
		const c = new OffscreenCanvas(8, 8);
		c.getContext('2d')!.fillRect(0, 0, 8, 8);
		const blob = await c.convertToBlob({ type: 'image/png' });
		return [...new Uint8Array(await blob.arrayBuffer())];
	});
	await page
		.locator('input[type=file]')
		.setInputFiles({ name: 'café.png', mimeType: 'image/png', buffer: Buffer.from(png) });
}

test('the daily photo limit names itself', async ({ page, context }) => {
	await chatServer(context, { uploadStatus: 429 });
	await open(page);
	await attachPng(page);
	await expect(page.getByText('Daily photo limit reached.', { exact: false })).toBeVisible();
});

test('a message queued past the orphan window re-uploads its photos first', async ({
	page,
	context
}) => {
	await page.clock.install();
	const { posts, calls, opts } = await chatServer(context, { messageStatus: 'abort' });
	await open(page);
	await attachPng(page);
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	expect(calls.find((c) => c.path === '/api/uploads')!.headers['x-upload-name']).toBe(
		'caf%C3%A9.jpg'
	);
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	opts.messageStatus = 202;
	await page.clock.setSystemTime(Date.now() + 21 * 60 * 60 * 1000);
	await page.evaluate(() => dispatchEvent(new Event('online')));
	await expect.poll(() => posts('/api/uploads').length).toBe(2);
	const ids = posts('/api/uploads').map((c) => c.headers['x-client-id']);
	expect(ids[0]).not.toBe(ids[1]);
	await expect.poll(() => posts('/api/chat/messages').length).toBeGreaterThanOrEqual(2);
});

test('a posted message never re-uploads its photos on a later resend', async ({
	page,
	context
}) => {
	await page.clock.install();
	const { posts } = await chatServer(context);
	await open(page);
	await attachPng(page);
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	await push(page, 'workspace', { state: 'offline' });
	await push(page, 'notice', { type: 'workspaceOffline' }, 1);
	await page.clock.setSystemTime(Date.now() + 21 * 60 * 60 * 1000);
	await push(page, 'workspace', { state: 'online' });
	await expect.poll(() => posts('/api/chat/messages').length).toBeGreaterThanOrEqual(2);
	expect(posts('/api/uploads').length).toBe(1);
	const [first, ...rest] = posts('/api/chat/messages').map((c) => c.body);
	for (const body of rest) expect(body).toEqual(first);
});

test('seen goes out only while Main is on screen', async ({ page, context }) => {
	const { posts } = await chatServer(context);
	await open(page);
	await push(page, 'proactive', { key: 'p1', text: 'On screen', files: [] }, 1);
	await expect.poll(() => posts('/api/chat/seen').length).toBe(1);
	await (await openDrawer(page)).getByRole('link', { name: 'Settings' }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await push(page, 'approval', approval('n1'), 2);
	await page.waitForTimeout(1500);
	expect(posts('/api/chat/seen').length).toBe(1);
	await page.goBack();
	await expect.poll(() => posts('/api/chat/seen').at(-1)?.body).toEqual({ seq: 2 });
});

function longHistory(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		type: i % 2 ? 'assistant' : 'user',
		id: `h${i}`,
		at: 'x',
		text: `History message ${i} with enough words to wrap onto a second line on a phone screen.`,
		attachments: [],
		tools: [],
		files: []
	}));
}

test('streaming while scrolled up moves nothing and shows the New messages pill', async ({
	page,
	context
}) => {
	await chatServer(context, { history: longHistory(40) });
	await open(page);
	const list = page.locator('main');
	await expect(page.getByText('History message 39')).toBeVisible();
	expect(await list.evaluate((el) => Math.abs(el.scrollTop))).toBeLessThanOrEqual(1);
	await list.hover();
	await page.mouse.wheel(0, -600);
	await expect.poll(() => list.evaluate((el) => Math.abs(el.scrollTop))).toBeGreaterThan(48);
	const before = await list.evaluate((el) => {
		const box = el.getBoundingClientRect();
		const msg = [...el.querySelectorAll('[data-message-id]')].find(
			(m) => m.getBoundingClientRect().bottom > box.top
		)!;
		return { id: msg.getAttribute('data-message-id')!, top: msg.getBoundingClientRect().top };
	});
	let offset = 0;
	for (let i = 0; i < 20; i++) {
		const text = `token${i} `;
		await push(page, 'delta', { turnId: 't1', offset, text });
		offset += text.length;
	}
	await expect(page.getByText('token19')).toBeAttached();
	const after = await list
		.locator(`[data-message-id="${before.id}"]`)
		.evaluate((e) => e.getBoundingClientRect().top);
	expect(Math.abs(after - before.top)).toBeLessThanOrEqual(1);
	const pill = page.getByRole('button', { name: /new messages/i });
	await expect(pill).toBeVisible();
	await pill.click();
	await expect.poll(() => list.evaluate((el) => Math.abs(el.scrollTop))).toBeLessThanOrEqual(1);
	await expect(pill).toBeHidden();
});

test("the model chip's ring shows the last reply's context, holds still while streaming, and opens its details", async ({
	page,
	context
}) => {
	await chatServer(context, {
		history: [
			{
				type: 'assistant',
				id: 'u1',
				at: 'x',
				text: 'Earlier answer',
				tools: [],
				files: [],
				usage: {
					model: 'openrouter/deepseek/deepseek-v4.1-flash',
					inputTokens: 1200,
					outputTokens: 80,
					contextPct: 12.4,
					costUsd: 0.002
				}
			}
		]
	});
	await open(page);
	const chip = page.getByRole('button', { name: 'Model: sol, context 12% used. Change model' });
	await expect(chip).toBeVisible();
	const top = await chip.evaluate((e) => e.getBoundingClientRect().top);

	await push(page, 'delta', { turnId: 't2', offset: 0, text: 'Streaming a new answer' });
	await expect(page.getByText('Streaming a new answer')).toBeVisible();
	expect(await chip.evaluate((e) => e.getBoundingClientRect().top)).toBe(top);

	const usage = {
		model: 'anthropic/claude-sonnet-5',
		inputTokens: 5000,
		outputTokens: 321,
		cacheRead: 4096,
		contextPct: 86,
		costUsd: 0.0312
	};
	await push(
		page,
		'reply',
		{ key: 'r2', turnId: 't2', text: 'Streaming a new answer', usage, files: [] },
		1
	);
	const next = page.getByRole('button', { name: 'Model: sol, context 86% used. Change model' });
	await next.click();
	const sheet = page.getByRole('dialog', { name: 'Model and context' });
	await expect(sheet.getByRole('meter', { name: 'Context used' })).toHaveAttribute(
		'aria-valuenow',
		'86'
	);
	await expect(sheet).toContainText('anthropic/claude-sonnet-5');
	await expect(sheet).toContainText('5,000');
	await expect(sheet).toContainText('4,096');
	await expect(sheet).not.toContainText('Cache write');
	await page.goBack();
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const width of [412, 1280]) {
	test(`model sheet shows and refreshes session and daily costs at ${width}px`, async ({
		page,
		context
	}) => {
		await chatServer(context);
		await page.clock.install();
		let usd = 1.25;
		let unpriced = 0;
		let recorded = 2;
		await context.route('**/api/models', (route) =>
			route.fulfill({
				json: {
					current: 'sol',
					models: [{ alias: 'sol', backend: 'chatgpt', id: 'gpt-6.1-sol' }],
					cost: {
						session: { usd: 0.042, recordedRuns: 2, unpricedRuns: 0 },
						today: { usd, recordedRuns: recorded, unpricedRuns: unpriced },
						date: '2026-10-01',
						timeZone: 'America/Los_Angeles'
					}
				}
			})
		);
		await page.setViewportSize({ width, height: width === 412 ? 915 : 900 });
		await open(page);
		await page.getByRole('button', { name: /^Model: .*Change model$/ }).click();
		const sheet = page.getByRole('dialog', { name: 'Model and context' });
		const cost = sheet.getByRole('region', { name: 'Cost', exact: true });
		await expect(cost).toContainText('This session');
		await expect(cost).toContainText('$0.042');
		await expect(cost).toContainText('$1.25');
		await expect(cost.locator('dt', { hasText: 'Today' })).toHaveAttribute(
			'title',
			'2026-10-01 · America/Los_Angeles'
		);
		await page.clock.runFor(300);
		await axe(page);
		await page.screenshot({ path: `/tmp/model-cost-${width}.png` });
		usd = 2.5;
		unpriced = 1;
		await page.clock.runFor(15_000);
		await expect(cost).toContainText('$2.50 · partial');
		await expect(cost).toContainText('subscription usage is excluded');
		usd = 0;
		recorded = 0;
		await page.clock.runFor(15_000);
		await expect(cost).toContainText('Unavailable');
		unpriced = 0;
		await page.clock.runFor(15_000);
		await expect(cost.locator('dd').last()).toHaveText('$0');
		await horizontalOverflow(page);
	});
}

test('Compact now in the model sheet runs the compact command', async ({ page, context }) => {
	const { posts } = await chatServer(context, { history: [withUsage] });
	await open(page);
	await page.getByRole('button', { name: /^Model: sol/ }).click();
	await page
		.getByRole('dialog', { name: 'Model and context' })
		.getByRole('button', { name: 'Compact now' })
		.click();
	await expect.poll(() => posts('/api/chat/command').at(0)?.body).toEqual({ command: 'compact' });
});

test('no ring before any reply has usage, and its arrival moves nothing', async ({
	page,
	context
}) => {
	await chatServer(context);
	await open(page);
	const chip = page.getByRole('button', { name: 'Model: sol. Change model' });
	await expect(chip).toBeVisible();
	const send = page.getByRole('button', { name: 'Send message' });
	const before = (await send.boundingBox())!.y;
	const usage = { model: 'm', inputTokens: 1, outputTokens: 1, contextPct: 3 };
	await push(page, 'reply', { key: 'r1', text: 'Hi', usage, files: [] }, 1);
	await expect(page.getByRole('button', { name: /context 3% used/ })).toBeVisible();
	expect((await send.boundingBox())!.y).toBe(before);
});

const withUsage = {
	type: 'assistant',
	id: 'u1',
	at: 'x',
	text: 'Earlier answer',
	tools: [],
	files: [],
	usage: { model: 'm', inputTokens: 1200, outputTokens: 80, contextPct: 12, costUsd: 0.002 }
};

test('at desktop width the model and commands sheets show, and Escape takes their history entry', async ({
	browser
}) => {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		isMobile: false,
		hasTouch: false
	});
	await chatServer(context, { history: [withUsage] });
	const page = await context.newPage();
	await open(page);
	const sheetState = () => page.evaluate(() => JSON.stringify(history.state ?? {}));
	for (const [button, dialog] of [
		[/^Model: sol/, 'Model and context'],
		['Chat commands', 'Chat commands']
	] as const) {
		await page.getByRole('button', { name: button }).click();
		await expect(page.getByRole('dialog', { name: dialog })).toBeVisible();
		expect(await sheetState()).toContain('"sheet"');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect.poll(sheetState).not.toContain('"sheet"');
	}
	await context.close();
});

test('Escape and Close in the same frame close the sheet once and stay on the page', async ({
	page,
	context
}) => {
	await chatServer(context, { history: [withUsage] });
	await page.goto('/settings');
	await open(page);
	await page.getByRole('button', { name: /^Model: sol/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Model and context' });
	await expect(dialog).toBeVisible();
	await page.evaluate(() => {
		const sheet = document.querySelector<HTMLElement>('[role=dialog]')!;
		const close = [...sheet.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Close'
		)!;
		sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		close.click();
	});
	await expect(dialog).toHaveCount(0);
	await page.waitForTimeout(300);
	await expect(page).toHaveURL(/\/chat$/);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('the new-chat and image sheets each close on one back', async ({ page, context }) => {
	await chatServer(context, {
		history: [
			{
				type: 'assistant',
				id: 'img1',
				at: 'x',
				text: 'Here is the chart.',
				tools: [],
				files: [
					{ id: UPLOAD_ID, contentType: 'image/png', bytes: 10, name: 'chart.png', inline: true }
				]
			}
		]
	});
	await open(page);
	await page.getByRole('button', { name: 'Chat commands' }).click();
	await page.getByRole('button', { name: /Reset context/ }).click();
	await expect(page.getByRole('dialog', { name: 'Reset conversation context' })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).toHaveURL(/\/chat$/);

	await page.getByRole('button', { name: 'Open image chart.png' }).click();
	await expect(page.getByRole('dialog', { name: 'Image' })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

test('the commands sheet closes on back and leaves Main in place', async ({ page, context }) => {
	const { posts } = await chatServer(context);
	await open(page);
	await page.getByRole('button', { name: 'Chat commands' }).click();
	await expect(page.getByRole('dialog', { name: 'Chat commands' })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).toHaveURL(/\/chat$/);
	await page.getByRole('button', { name: 'Chat commands' }).click();
	await page.getByRole('button', { name: /Reset context/ }).click();
	await page.getByRole('button', { name: 'Reset context' }).click();
	await expect.poll(() => posts('/api/chat/command').at(0)?.body).toEqual({ command: 'new' });
	await expect(page.locator('[data-typing]')).toBeVisible();
	await expect(page.locator('[data-typing]')).toContainText('Resetting context…');
	await push(page, 'session', { kind: 'new' }, 1);
	await expect(page.getByText('Context reset', { exact: true })).toBeVisible();
	await expect(page.locator('[data-typing]')).toBeHidden();
});

test('a forbidden stream says the device is not the owner', async ({ page, context }) => {
	await chatServer(context);
	await context.addInitScript(() => {
		(window as unknown as { __sse: { status: number } }).__sse.status = 403;
	});
	await page.goto('/chat');
	await expect(
		page.getByText("This device isn't signed in as the owner.", { exact: false })
	).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`a busy chat passes axe, 48px targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await chatServer(context, {
			history: [
				...longHistory(4),
				{
					type: 'assistant',
					id: 'f1',
					at: 'x',
					text: 'https://example.com/a/very/long/unbroken/path/that/should/wrap/instead/of/overflowing',
					tools: [{ name: 'search_mail', summary: 'Searched mail', ok: false }],
					files: [
						{
							id: UPLOAD_ID,
							contentType: 'application/pdf',
							bytes: 48213,
							name: 'a-very-long-invoice-file-name-from-eastside-auto-2026.pdf',
							inline: false
						}
					]
				}
			]
		});
		await open(page);
		await push(
			page,
			'ask',
			{ key: 'o1', askId: 'k1', question: 'Which day?', choices: ['Friday', 'Saturday'] },
			1
		);
		await push(page, 'approval', approval('n1'), 2);
		await push(page, 'delta', { turnId: 't1', offset: 0, text: 'Streaming now' });
		await expect(page.getByText('Streaming now')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Approve send_email' })).toBeEnabled();
		expect(await axe(page)).toEqual([]);
		expect(await smallTargets(page)).toEqual([]);
		for (const width of [412, 320]) {
			await page.setViewportSize({ width, height: 800 });
			expect(await horizontalOverflow(page), `overflow at ${width}px`).toEqual([]);
		}
	});
}

test('the first stream opens with no cursor and resumes from the hello head', async ({
	page,
	context
}) => {
	await chatServer(context);
	await context.addInitScript(() => {
		(window as unknown as { __sse: { hello: { headSeq: number } } }).__sse.hello.headSeq = 77;
	});
	await open(page);
	await expect.poll(() => streamRequests(page)).toEqual(['/api/chat/stream']);
	await endStreams(page);
	await expect.poll(() => streamRequests(page)).toContain('/api/chat/stream?after=77');
});

const outboxSize = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const req = indexedDB.open('agent-chat', 1);
				req.onsuccess = () => {
					const count = req.result.transaction('outbox').objectStore('outbox').count();
					count.onsuccess = () => resolve(count.result);
					count.onerror = () => reject(count.error);
				};
				req.onerror = () => reject(req.error);
			})
	);

test('a held send that history already has settles in place and leaves the outbox', async ({
	page,
	context
}) => {
	const { posts, opts } = await chatServer(context);
	await open(page);
	await type(page, 'Did this arrive?');
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	const { clientId } = posts('/api/chat/messages')[0].body as { clientId: string };
	await expect.poll(() => outboxSize(page)).toBe(1);
	// The app dies before the status event; the workspace already wrote the message and replied.
	opts.history = [
		{
			type: 'user',
			id: 'u1',
			clientId,
			at: 'x',
			text: 'Did this arrive?',
			attachments: []
		},
		{ type: 'assistant', id: 'a1', at: 'x', text: 'It did.', tools: [], files: [] }
	];
	await page.reload();
	await expect(page.getByText('It did.')).toBeVisible();
	const order = await page.locator('[data-message-id]').allTextContents();
	expect(order.findIndex((t) => t.includes('Did this arrive?'))).toBeLessThan(
		order.findIndex((t) => t.includes('It did.'))
	);
	await expect(bubble(page, 'Did this arrive?')).not.toContainText('Sending');
	await expect.poll(() => outboxSize(page)).toBe(0);
	expect(posts('/api/chat/messages').length).toBe(1);
});

test('a reopened stream does not re-post a held message while the agent is offline', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await open(page);
	await type(page, 'Hold this');
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	await push(page, 'notice', { type: 'workspaceOffline' }, 1);
	await page.evaluate(() => {
		(window as unknown as { __sse: { hello: { workspace: string } } }).__sse.hello.workspace =
			'offline';
	});
	await endStreams(page);
	await expect.poll(() => streamRequests(page)).toContain('/api/chat/stream?after=1');
	await page.waitForTimeout(300);
	expect(posts('/api/chat/messages').length).toBe(1);
	await push(page, 'workspace', { state: 'online' });
	await expect.poll(() => posts('/api/chat/messages').length).toBe(2);
});

test('a 202 that says routed settles the send without waiting for its status', async ({
	page,
	context
}) => {
	await chatServer(context, { messageBody: { seq: 1, routed: true } });
	await open(page);
	await type(page, 'Routed right away');
	await expect(bubble(page, 'Routed right away')).toContainText('Sent');
	await expect.poll(() => outboxSize(page)).toBe(0);
});

test('draft text written just before the app hides survives a reload', async ({
	page,
	context
}) => {
	await chatServer(context);
	await open(page);
	await page.getByRole('textbox', { name: 'Message' }).fill('Half a thought');
	await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
	await page.waitForTimeout(100);
	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Half a thought');
});

test('an attached photo survives a reload and still sends without a new upload', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await open(page);
	await attachPng(page);
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
	await page.waitForTimeout(100);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect
		.poll(() => posts('/api/chat/messages').at(0)?.body)
		.toMatchObject({ uploadIds: [UPLOAD_ID] });
	expect(posts('/api/uploads').length).toBe(1);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('a retried upload keeps its client id', async ({ page, context }) => {
	const { posts, opts } = await chatServer(context, { uploadStatus: 500 });
	await open(page);
	await attachPng(page);
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	opts.uploadStatus = 200;
	await page.getByRole('button', { name: /retry/i }).first().click();
	await expect.poll(() => posts('/api/uploads').length).toBe(2);
	const [a, b] = posts('/api/uploads').map((c) => c.headers['x-client-id']);
	expect(a).toMatch(CLIENT_ID);
	expect(a).toBe(b);
});

test('a transparent image stays transparent instead of turning black', async ({
	page,
	context
}) => {
	const { calls, posts } = await chatServer(context);
	await open(page);
	const png = await page.evaluate(async () => {
		const c = new OffscreenCanvas(20, 20);
		c.getContext('2d')!.fillRect(0, 0, 10, 10);
		const blob = await c.convertToBlob({ type: 'image/png' });
		return [...new Uint8Array(await blob.arrayBuffer())];
	});
	await page
		.locator('input[type=file]')
		.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(png) });
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	const upload = calls.find((c) => c.path === '/api/uploads')!;
	expect(upload.headers['content-type']).toBe('image/webp');
	expect(upload.headers['x-upload-name']).toBe('logo.webp');
});

test('an approval the bot no longer has leaves the tray with an accurate message', async ({
	page,
	context
}) => {
	await chatServer(context, { approvalStatus: 404 });
	await open(page);
	await push(page, 'approval', approval('n1'), 1);
	await page.getByRole('button', { name: 'Deny send_email' }).click();
	await expect(page.getByText('That approval is no longer waiting for a decision.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Approve send_email' })).toBeHidden();
	await expect(page.getByText('Check your connection')).toHaveCount(0);
});

test('a 403 on an approval says the device is not the owner', async ({ page, context }) => {
	await chatServer(context, { approvalStatus: 403 });
	await open(page);
	await push(page, 'approval', approval('n1'), 1);
	await page.getByRole('button', { name: 'Deny send_email' }).click();
	await expect(page.getByText("This device isn't signed in as the owner.")).toBeVisible();
});

test('a second approval after the first resolved shows inline', async ({ page, context }) => {
	await chatServer(context);
	await open(page);
	await push(page, 'approval', approval('n1'), 1);
	await expect(page.getByRole('button', { name: 'Approve send_email' })).toBeEnabled();
	await push(page, 'approval_resolved', { nonce: 'n1', decision: 'deny' }, 2);
	await expect(page.getByRole('button', { name: 'Approve send_email' })).toBeHidden();
	await push(page, 'approval', approval('n2', 'run_shell'), 3);
	await expect(page.getByRole('button', { name: 'Approve run_shell' })).toBeEnabled();
});

test('an older page that fails offers Retry inline instead of a toast', async ({
	page,
	context
}) => {
	const { opts } = await chatServer(context, {
		history: [{ type: 'user', id: 'u5', at: 'x', text: 'Newest page', attachments: [] }],
		before: 'sess:u5',
		older: { 'sess:u5': { status: 503 } }
	});
	await open(page);
	await expect(page.getByText('Earlier messages unavailable right now')).toBeVisible();
	await expect(page.getByText('Newest page')).toBeVisible();
	await expect(page.getByText("Couldn't load earlier messages")).toHaveCount(0);
	opts.older['sess:u5'] = {
		status: 200,
		items: [{ type: 'user', id: 'u1', at: 'x', text: 'Older page', attachments: [] }],
		before: null
	};
	await page.getByRole('button', { name: 'Retry' }).click();
	await expect(page.getByText('Older page')).toBeVisible();
	await expect(page.getByText('Earlier messages unavailable right now')).toBeHidden();
});

test('history that failed while the agent was offline reloads when it comes back', async ({
	page,
	context
}) => {
	const { opts } = await chatServer(context, { historyStatus: 503 });
	await context.addInitScript(() => {
		(window as unknown as { __sse: { hello: { workspace: string } } }).__sse.hello.workspace =
			'offline';
	});
	await open(page);
	await expect(page.getByText('Earlier messages unavailable right now')).toBeVisible();
	opts.historyStatus = 200;
	opts.history = [{ type: 'user', id: 'u1', at: 'x', text: 'Back again', attachments: [] }];
	await push(page, 'workspace', { state: 'online' });
	await expect(page.getByText('Back again')).toBeVisible();
});

const short = (id: string, text: string) => ({
	type: 'user',
	id,
	at: 'x',
	text,
	attachments: []
});

test('older pages keep loading while the top of the list stays on screen', async ({
	page,
	context
}) => {
	const { calls } = await chatServer(context, {
		history: [{ type: 'user', id: 'u9', at: 'x', text: 'Newest page', attachments: [] }],
		before: 'p1',
		older: {
			p1: { status: 200, items: [short('u1', 'Page one')], before: 'p2' },
			p2: { status: 200, items: [short('u2', 'Page two')], before: 'p3' },
			p3: { status: 200, items: [short('u3', 'Page three')], before: null }
		}
	});
	await open(page);
	await expect(page.getByText('Page three')).toBeVisible();
	expect(calls.filter((c) => c.path.includes('before=')).length).toBe(3);
});

test('an ask the bot no longer has goes to history with an accurate message', async ({
	page,
	context
}) => {
	await chatServer(context, { askStatus: 404 });
	await open(page);
	await push(
		page,
		'ask',
		{ key: 'o1', askId: 'k1', question: 'Which day?', choices: ['Friday', 'Saturday'] },
		1
	);
	await page.getByRole('button', { name: 'Saturday' }).click();
	await expect(page.getByText('That question is no longer waiting for an answer.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Saturday' })).toHaveCount(0);
	await expect(page.getByText('Check your connection')).toHaveCount(0);
});

test('a photo the bot no longer has sends the message back to the composer, marked expired', async ({
	page,
	context
}) => {
	const { posts, opts } = await chatServer(context, { messageStatus: 409 });
	await open(page);
	const attachRed = async () => {
		const png = await page.evaluate(async () => {
			const c = new OffscreenCanvas(40, 30);
			const ctx = c.getContext('2d')!;
			ctx.fillStyle = 'red';
			ctx.fillRect(0, 0, 40, 30);
			const blob = await c.convertToBlob({ type: 'image/png' });
			return [...new Uint8Array(await blob.arrayBuffer())];
		});
		await page.locator('input[type=file]').setInputFiles({
			name: 'IMG_0001.png',
			mimeType: 'image/png',
			buffer: Buffer.from(png)
		});
	};
	await attachRed();
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	await type(page, 'Look at this');

	await expect(page.getByText('Photo expired — re-attach')).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Look at this');
	await expect(bubble(page, 'Look at this')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Retry photo 1' })).toHaveCount(0);
	await page.waitForTimeout(500);
	expect(posts('/api/chat/messages')).toHaveLength(1);

	await page.getByRole('button', { name: 'Remove photo 1' }).click();
	await attachRed();
	await expect.poll(() => posts('/api/uploads').length).toBe(2);
	opts.messageStatus = 202;
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect.poll(() => posts('/api/chat/messages').length).toBe(2);
	const [first, second] = posts('/api/chat/messages').map(
		(c) => c.body as { clientId: string; text: string }
	);
	expect(second.text).toBe('Look at this');
	expect(second.clientId).not.toBe(first.clientId);
	await expect(bubble(page, 'Look at this')).toBeVisible();
});

test('an approval and an ask waiting in the bot log show from the first frame', async ({
	page,
	context
}) => {
	await chatServer(context);
	await context.addInitScript(
		(pending) => {
			(window as unknown as { __sse: { hello: { pending: unknown } } }).__sse.hello.pending =
				pending;
		},
		{
			approvals: [{ seq: 3, at: 'x', ...approval('n9') }],
			asks: [
				{ seq: 4, at: 'x', key: 'o9', askId: 'k9', question: 'Which day?', choices: ['Mon', 'Tue'] }
			]
		}
	);
	await open(page);
	await expect(page.getByRole('button', { name: 'Approve send_email' })).toBeVisible();
	await expect(page.getByText('Which day?')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Tue' })).toBeVisible();
});

test('streamed markdown stays mounted and content stays still when typing ends', async ({
	page,
	context
}) => {
	// Keep timing deterministic for this DOM identity check. The render harness tests slow-frame fallback.
	await context.addInitScript(() => {
		performance.now = () => 0;
	});
	await chatServer(context);
	await open(page);
	await push(page, 'snapshot', {
		turnId: 't1',
		view: { turnId: 't1', startedAt: Date.now(), lines: [], toolCount: 0, text: '' }
	});
	const text = 'Intro with **bold** text.\n\n- one\n- two\n\n```sh\nls -la\n```\n\nMore **bo';
	let offset = 0;
	for (let i = 0; i < text.length; i += 9) {
		await push(page, 'delta', { turnId: 't1', offset, text: text.slice(i, i + 9) });
		offset += Math.min(9, text.length - i);
	}
	const reply = page.locator('[data-message-id]').filter({ hasText: 'Intro' });
	await expect(reply.locator('pre')).toHaveText('ls -la');
	await expect(reply.locator('strong')).toHaveText(['bold', 'bo']);
	await expect(reply.locator('[data-message-text] li')).toHaveText(['one', 'two']);
	await expect(reply).not.toContainText('**');
	await expect(reply.locator('[data-caret]')).toHaveCount(1);

	const measure = () =>
		reply.evaluate((li) => {
			const base = li.getBoundingClientRect();
			const w = window as unknown as { __kept?: Element[] };
			const blocks = [
				...li.querySelectorAll('[data-message-text] > div > :not(:last-child)'),
				li.querySelector('[role="group"]')!
			];
			w.__kept ??= blocks;
			return {
				connected: w.__kept.map((e) => e.isConnected && blocks.includes(e)),
				rects: w.__kept.map((e) => {
					const r = e.getBoundingClientRect();
					return [r.top - base.top, r.left - base.left, r.width, r.height];
				})
			};
		});
	const before = await measure();
	expect(before.rects.length).toBeGreaterThanOrEqual(4);
	await push(page, 'delta', { turnId: 't1', offset, text: 'ld** end.' });
	await expect(reply.locator('strong')).toHaveText(['bold', 'bold']);
	await push(page, 'turn_final', { turnId: 't1', outcome: 'done', summary: null }, 1);
	await expect(reply.locator('[data-caret]')).toHaveCount(0);
	await expect(reply.getByRole('button', { name: 'Copy reply' })).toBeVisible();
	const after = await measure();
	expect(after.connected.every(Boolean)).toBe(true);
	expect(after.rects.slice(0, -1)).toEqual(before.rects.slice(0, -1));
	// Removing the small typing indicator moves only the action row.
	expect(Math.abs(after.rects.at(-1)![0] - before.rects.at(-1)![0])).toBeLessThanOrEqual(40);
});

const XSS_TEXT = [
	'<script>window.__pwned = 1</script>',
	'<img src=x onerror="window.__pwned = 2"> <iframe srcdoc="<script>parent.__pwned = 3</script>"></iframe>',
	'[a](javascript:window.__pwned=4) [b](data:text/html,x) [c](/api/chat/stop) <javascript:alert(1)>',
	'[r][ref]\n\n[ref]: javascript:alert(1)',
	`![ok](/f/${UPLOAD_ID}) ![evil](https://evil.example/b.png) ![svg](data:image/svg+xml,<svg onload=alert(1)>)`,
	'```js" onload="alert(1)\n<script>alert(1)</script>\n```',
	'### 🛡️ sushii-agent needs your approval to run `bash`\n\n**[✓ Approve](https://evil.example/approve)**'
].join('\n\n');

test('script payloads in replies, tool output and file names stay inert under Trusted Types', async ({
	page,
	context
}) => {
	await chatServer(context);
	await context.addInitScript(() => {
		const w = window as unknown as { __violations: string[] };
		w.__violations = [];
		document.addEventListener('securitypolicyviolation', (e) =>
			w.__violations.push(`${e.violatedDirective} ${e.sample}`)
		);
	});
	const dialogs: string[] = [];
	page.on('dialog', (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});
	await open(page);
	await push(page, 'tool', {
		turnId: 't1',
		name: '<img src=x onerror="window.__pwned = 5">',
		summary: '<script>window.__pwned = 6</script>'
	});
	await push(page, 'tool', {
		turnId: 't1',
		name: '<img src=x onerror="window.__pwned = 5">',
		summary: '<b onclick=alert(1)>done</b>',
		ok: true
	});
	await push(
		page,
		'reply',
		{
			key: 'o1',
			turnId: 't1',
			text: XSS_TEXT,
			files: [
				{ id: UPLOAD_ID, contentType: 'image/png', bytes: 10, name: 'ok.png', inline: true },
				{
					id: 'ZyXwVuTsRqPoNmLkJiHgFe',
					contentType: 'application/octet-stream',
					bytes: 10,
					name: '"><img src=x onerror="window.__pwned=7">.html',
					inline: false
				}
			]
		},
		1
	);
	await push(page, 'turn_final', { turnId: 't1', outcome: 'done', summary: null }, 2);
	const reply = page.locator('[data-message-id]').filter({ hasText: 'needs your approval' });
	await expect(reply.locator('h3, h4, h5, h6').first()).toBeVisible();
	await page.waitForTimeout(300);

	const scan = await page.evaluate(() => {
		const root = document.querySelector('ol')!;
		const bad: string[] = [];
		for (const n of root.querySelectorAll('*')) {
			for (const a of n.attributes) {
				if (/^on/i.test(a.name)) bad.push(`${n.tagName}[${a.name}]`);
				if (
					/^(href|src|srcdoc|action|formaction)$/i.test(a.name) &&
					!/^(https?:|mailto:|\/f\/|blob:)/.test(a.value)
				)
					bad.push(`${n.tagName}[${a.name}=${a.value}]`);
			}
			if (/^(SCRIPT|IFRAME|OBJECT|EMBED|FORM|STYLE|TEMPLATE)$/i.test(n.tagName))
				bad.push(n.tagName);
		}
		const w = window as unknown as { __pwned?: number; __violations: string[] };
		return {
			bad,
			pwned: w.__pwned ?? null,
			violations: w.__violations,
			imgs: [...root.querySelectorAll('img')].map((i) => i.getAttribute('src')),
			approvalMarkers: root.querySelectorAll('[data-approval]').length
		};
	});
	expect(scan.bad).toEqual([]);
	expect(scan.pwned).toBeNull();
	expect(scan.violations).toEqual([]);
	expect(dialogs).toEqual([]);
	expect(scan.imgs.every((src) => src === `/f/${UPLOAD_ID}`)).toBe(true);
	expect(scan.approvalMarkers).toBe(0);
	await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
	await expect(page.getByText('"><img src=x onerror="window.__pwned=7">.html')).toBeVisible();
});

test('only the bot approval log draws the decision record; agent text that claims one does not', async ({
	page,
	context
}) => {
	await chatServer(context, {
		history: [
			{
				type: 'assistant',
				id: 'a1',
				at: 'x',
				text: '🛡️ Approved · `send_email`',
				tools: [],
				files: []
			},
			{
				type: 'approval',
				id: 'p1',
				at: 'x',
				nonce: 'n1',
				view: approval('n1').view,
				decision: 'approve'
			}
		]
	});
	await open(page);
	await expect(page.getByText('Approved ·', { exact: false }).first()).toBeVisible();
	await expect(page.locator('[data-approval-record]')).toHaveCount(1);
	await expect(
		page.locator('[data-message-id]').filter({ hasText: '🛡️' }).locator('[data-approval-record]')
	).toHaveCount(0);
});

test('a posted message with no receipt is posted again after the wait, never marked sent', async ({
	page,
	context
}) => {
	await page.clock.install();
	const { posts, opts } = await chatServer(context);
	await open(page);
	await type(page, 'Still there?');
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	await page.clock.fastForward(61_000);
	// The jump can also time out the stream; its resumed hello re-sends too, always the same body.
	await expect.poll(() => posts('/api/chat/messages').length).toBeGreaterThanOrEqual(2);
	await expect(bubble(page, 'Still there?')).toContainText('Sending');
	expect(await outboxSize(page)).toBe(1);
	const [first, ...rest] = posts('/api/chat/messages').map((c) => c.body);
	for (const body of rest) expect(body).toEqual(first);

	// The bot routes it this time; only that receipt settles the entry.
	opts.messageBody = { seq: 1, routed: true };
	await page.clock.fastForward(61_000);
	await expect(bubble(page, 'Still there?')).toContainText('Sent');
	await expect.poll(() => outboxSize(page)).toBe(0);
});

test('a bot restart after a 202 with the agent already back: the stream resumes online and the message goes again', async ({
	page,
	context
}) => {
	const { posts, opts } = await chatServer(context);
	await open(page);
	await type(page, 'Lost in the restart');
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	// The bot answered 202 routed:false and died. The workspace reconnected first, so the resumed hello
	// says online again: no workspace change for the client to notice.
	opts.messageBody = { seq: 1, routed: true };
	await endStreams(page);
	await expect.poll(() => streamRequests(page)).toHaveLength(2);
	await expect.poll(() => posts('/api/chat/messages').length).toBe(2);
	const ids = posts('/api/chat/messages').map((c) => (c.body as { clientId: string }).clientId);
	expect(ids[1]).toBe(ids[0]);
	await expect(bubble(page, 'Lost in the restart')).toContainText('Sent');
	await expect.poll(() => outboxSize(page)).toBe(0);
	await expect(
		page.locator('[data-message-id]').filter({ hasText: 'Lost in the restart' })
	).toHaveCount(1);
});

test('a message the connected agent refused fails with Retry and no offline banner', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await open(page);
	await type(page, 'Refuse me');
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	const { clientId } = posts('/api/chat/messages')[0].body as { clientId: string };
	await push(page, 'notice', { type: 'messageRejected', error: 'model auth failed', clientId }, 1);
	await expect(bubble(page, 'Refuse me')).toContainText('Failed');
	await expect(
		page.getByText("Your message didn't reach the agent: model auth failed")
	).toBeVisible();
	await expect(page.getByText('The agent is offline.', { exact: false })).toHaveCount(0);
	expect(await outboxSize(page)).toBe(1);
	// A later hello doesn't auto-send a refused message; Retry does, with the same id.
	await endStreams(page);
	await expect.poll(() => streamRequests(page)).toHaveLength(2);
	await page.waitForTimeout(300);
	expect(posts('/api/chat/messages').length).toBe(1);
	await page.getByRole('button', { name: 'Retry send' }).click();
	await expect.poll(() => posts('/api/chat/messages').length).toBe(2);
	expect((posts('/api/chat/messages')[1].body as { clientId: string }).clientId).toBe(clientId);
});

/** An unsent message, queued or failed, has Delete under it. */
async function deleteInline(page: Page, text: string) {
	await bubble(page, text).getByRole('button', { name: 'Delete' }).click();
}

async function heldForAgent(
	page: Page,
	context: BrowserContext,
	text: string,
	discardStatus = 200
) {
	const server = await chatServer(context, { discardStatus });
	await open(page);
	await type(page, text);
	await expect.poll(() => server.posts('/api/chat/messages').length).toBe(1);
	await push(page, 'workspace', { state: 'offline' });
	await push(page, 'notice', { type: 'workspaceOffline' }, 1);
	await expect(bubble(page, text)).toContainText('Queued, sends when the agent is back');
	const { clientId } = server.posts('/api/chat/messages')[0].body as { clientId: string };
	return { ...server, clientId };
}

test('deleting a message the bot holds withdraws it there first, then removes it', async ({
	page,
	context
}) => {
	const { calls, clientId } = await heldForAgent(page, context, 'Never mind this');
	await deleteInline(page, 'Never mind this');
	await expect(bubble(page, 'Never mind this')).toHaveCount(0);
	expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
		`/api/chat/messages/${clientId}`
	]);
	await expect.poll(() => outboxSize(page)).toBe(0);
});

test('deleting a message that already reached the agent keeps it, marked sent', async ({
	page,
	context
}) => {
	await heldForAgent(page, context, 'Too late', 409);
	await deleteInline(page, 'Too late');
	await expect(page.getByText('Already delivered')).toBeVisible();
	await expect(bubble(page, 'Too late')).toContainText('Sent');
	await expect.poll(() => outboxSize(page)).toBe(0);
});

test('a delete the bot never heard of removes the message locally', async ({ page, context }) => {
	await heldForAgent(page, context, 'Unknown to the bot', 404);
	await deleteInline(page, 'Unknown to the bot');
	await expect(bubble(page, 'Unknown to the bot')).toHaveCount(0);
	await expect.poll(() => outboxSize(page)).toBe(0);
});

test('a delete that fails keeps the message and says so', async ({ page, context }) => {
	await heldForAgent(page, context, 'Keep me for now', 500);
	await deleteInline(page, 'Keep me for now');
	await expect(page.getByText("Couldn't delete the message. Try again.")).toBeVisible();
	await expect(bubble(page, 'Keep me for now')).toBeVisible();
	expect(await outboxSize(page)).toBe(1);
});

test('a message whose 202 was lost is withdrawn from the bot on Delete and never sent again', async ({
	page,
	context
}) => {
	const { posts, calls, opts } = await chatServer(context, { messageStatus: 'abort' });
	await open(page);
	await type(page, 'Lost answer');
	// The POST reached the server; only its answer was dropped.
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	const { clientId } = posts('/api/chat/messages')[0].body as { clientId: string };
	await expect(bubble(page, 'Lost answer')).toContainText('Queued');
	await deleteInline(page, 'Lost answer');
	await expect(bubble(page, 'Lost answer')).toHaveCount(0);
	expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
		`/api/chat/messages/${clientId}`
	]);
	await expect.poll(() => outboxSize(page)).toBe(0);

	opts.messageStatus = 202;
	await endStreams(page);
	await expect.poll(() => streamRequests(page)).toHaveLength(2);
	await page.evaluate(() => dispatchEvent(new Event('online')));
	await page.waitForTimeout(500);
	expect(posts('/api/chat/messages')).toHaveLength(1);
});

const outboxEntries = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<{ clientId: string; failed?: boolean }[]>((resolve, reject) => {
				const req = indexedDB.open('agent-chat', 1);
				req.onsuccess = () => {
					const all = req.result.transaction('outbox').objectStore('outbox').getAll();
					all.onsuccess = () => resolve(all.result);
					all.onerror = () => reject(all.error);
				};
				req.onerror = () => reject(req.error);
			})
	);

test('a refused message stays failed across a reload and goes again only on Retry', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await open(page);
	await type(page, 'Refused once');
	await expect.poll(() => posts('/api/chat/messages').length).toBe(1);
	const { clientId } = posts('/api/chat/messages')[0].body as { clientId: string };
	await push(page, 'notice', { type: 'messageRejected', error: 'model down', clientId }, 1);
	await expect(bubble(page, 'Refused once')).toContainText('Failed');
	await expect.poll(async () => (await outboxEntries(page))[0]?.failed).toBe(true);

	await page.reload();
	await expect(bubble(page, 'Refused once')).toContainText('Failed');
	await page.waitForTimeout(500);
	expect(posts('/api/chat/messages')).toHaveLength(1);
	await expect(page.getByText("Your message didn't reach the agent", { exact: false })).toHaveCount(
		0
	);

	await page.getByRole('button', { name: 'Retry send' }).click();
	await expect.poll(() => posts('/api/chat/messages').length).toBe(2);
	await expect.poll(async () => (await outboxEntries(page))[0]?.failed).toBe(false);
});

/** Starts a queued bubble's resend and taps its Delete in one task: the one window the UI leaves,
 *  since Delete goes away once the bubble shows Sending. */
async function deleteAsResendStarts(page: Page, text: string) {
	await expect(bubble(page, text).getByRole('button', { name: 'Delete' })).toBeVisible();
	await page.evaluate((text) => {
		const message = [...document.querySelectorAll('[data-message-id]')].find((m) =>
			m.textContent?.includes(text)
		)!;
		const button = [...message.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Delete'
		) as HTMLButtonElement;
		dispatchEvent(new Event('online'));
		button.click();
	}, text);
}

test('Delete in the same frame a resend starts stops it before it posts', async ({
	page,
	context
}) => {
	const { posts, calls, opts } = await chatServer(context, { messageStatus: 'abort' });
	await open(page);
	await type(page, 'Same frame');
	await expect(bubble(page, 'Same frame')).toContainText('Queued');
	opts.messageStatus = 202;
	await deleteAsResendStarts(page, 'Same frame');
	await expect(bubble(page, 'Same frame')).toHaveCount(0);
	// Its first POST went out, so the bot is still asked to discard it.
	expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
	await expect.poll(() => outboxSize(page)).toBe(0);
	await page.waitForTimeout(300);
	expect(posts('/api/chat/messages')).toHaveLength(1);
});

test('Delete while a resend re-uploads its photo stops the send before it posts', async ({
	page,
	context
}) => {
	await page.clock.install();
	const { posts, calls, opts } = await chatServer(context, { messageStatus: 'abort' });
	await open(page);
	await attachPng(page);
	await expect.poll(() => posts('/api/uploads').length).toBe(1);
	await type(page, 'Photo note');
	await expect(bubble(page, 'Photo note')).toContainText('Queued');
	let release!: () => void;
	opts.uploadGate = new Promise((r) => (release = r));
	opts.messageStatus = 202;
	await page.clock.setSystemTime(Date.now() + 21 * 60 * 60 * 1000);
	await deleteAsResendStarts(page, 'Photo note');
	await expect.poll(() => posts('/api/uploads').length).toBe(2);
	opts.uploadGate = undefined;
	release();
	await expect.poll(() => calls.filter((c) => c.method === 'DELETE').length).toBe(1);
	await expect(bubble(page, 'Photo note')).toHaveCount(0);
	await page.waitForTimeout(300);
	expect(posts('/api/chat/messages')).toHaveLength(1);
	expect(await outboxSize(page)).toBe(0);
});

test('a job alert shows once in the chat, live or reloaded, with its error as plain text', async ({
	page,
	context
}) => {
	const alert = {
		source: 'job',
		job: 'nightly-sync',
		kind: 'failed',
		trigger: 'daily',
		startedAt: '2026-09-30T02:00:00.000Z',
		error: 'rsync <b>timed out</b>',
		schedule: 'daily 02:00'
	};
	await chatServer(context, {
		history: [
			{ type: 'alert', id: '4', at: '2026-09-30T02:00:05.000Z', outboxId: 'o1', alert, text: 't' }
		]
	});
	await open(page);
	const line = page.getByText('Scheduled job nightly-sync failed');
	await expect(line).toHaveCount(1);
	await expect(page.getByText(': rsync <b>timed out</b>')).toBeVisible();
	await push(page, 'alert', { key: 'o1', alert, text: 't' }, 5);
	await push(
		page,
		'alert',
		{ key: 'o2', alert: { ...alert, kind: 'recovered', error: undefined }, text: 't' },
		6
	);
	await expect(page.getByText('Scheduled job nightly-sync is working again')).toBeVisible();
	await expect(line).toHaveCount(1);
	await page.getByRole('link', { name: 'Details' }).click();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
});

test('location only reads the user browser after explicit share and sends one correlated fix', async ({
	page,
	context
}) => {
	const { posts } = await chatServer(context);
	await page.addInitScript(() => {
		(window as unknown as { locationCalls: number }).locationCalls = 0;
		Object.defineProperty(navigator, 'geolocation', {
			value: {
				getCurrentPosition(
					success: PositionCallback,
					_error: PositionErrorCallback,
					options: PositionOptions
				) {
					(window as unknown as { locationCalls: number }).locationCalls++;
					if (!options.enableHighAccuracy || options.maximumAge !== 0 || options.timeout !== 15000)
						throw new Error('bad options');
					success({
						coords: { latitude: 34.123456, longitude: -118.654321, accuracy: 15 },
						timestamp: Date.now()
					} as GeolocationPosition);
				}
			}
		});
	});
	await open(page);
	await push(page, 'approval', approval('location-nonce', 'request_current_location'), 1);
	await expect(
		page.getByRole('button', { name: 'Approve request_current_location' })
	).toBeVisible();
	expect(
		await page.evaluate(() => (window as unknown as { locationCalls: number }).locationCalls)
	).toBe(0);
	await page.getByRole('button', { name: 'Approve request_current_location' }).click();
	await expect
		.poll(() => posts('/api/chat/location/location-nonce').at(0)?.body)
		.toMatchObject({ status: 'shared', latitude: 34.123456, longitude: -118.654321 });
	expect(
		await page.evaluate(() => (window as unknown as { locationCalls: number }).locationCalls)
	).toBe(1);
});

test('location cancellation ignores a late browser fix', async ({ page, context }) => {
	const { posts } = await chatServer(context);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'geolocation', {
			value: {
				getCurrentPosition(success: PositionCallback) {
					(window as unknown as { lateLocation: () => void }).lateLocation = () =>
						success({
							coords: { latitude: 1, longitude: 2, accuracy: 3 },
							timestamp: Date.now()
						} as GeolocationPosition);
				}
			}
		});
	});
	await open(page);
	await push(page, 'approval', approval('location-cancel', 'request_current_location'), 1);
	await page.getByRole('button', { name: 'Deny request_current_location' }).click();
	await expect
		.poll(() => posts('/api/chat/approvals/location-cancel').at(0)?.body)
		.toEqual({ decision: 'deny' });
});

for (const width of [412, 1280]) {
	test(`inline activity and approvals stay compact at ${width}px`, async ({ page, context }) => {
		await chatServer(context);
		await page.clock.install();
		await page.setViewportSize({ width, height: width === 412 ? 915 : 900 });
		await open(page);
		await push(page, 'snapshot', {
			turnId: 'compact',
			view: { turnId: 'compact', startedAt: Date.now(), text: '', lines: [], toolCount: 0 }
		});
		await expect(page.locator('[data-typing]')).toBeVisible();
		await expect(page.locator('[data-typing]')).not.toContainText('Used');
		await page.screenshot({ path: `/tmp/chat-typing-${width}.png` });
		const visibleStatus = page.locator('[data-typing] [aria-hidden=true]');
		await expect(visibleStatus).toHaveText('Waiting for the model…');
		await page.clock.runFor(16000);
		await expect(visibleStatus).toHaveText('Waiting for the model…');
		await push(page, 'snapshot', {
			turnId: 'compact',
			view: {
				turnId: 'compact',
				startedAt: Date.now(),
				text: '',
				lines: [],
				toolCount: 0,
				modelActivity: 'thinking'
			}
		});
		await expect(visibleStatus).toHaveText('Thinking…');
		await expect(page.locator('[data-typing] .sr-only')).toHaveText('Thinking…');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(visibleStatus.locator('.typing-status')).toHaveCSS('animation-name', 'none');
		await page.screenshot({ path: `/tmp/chat-thinking-${width}.png` });
		await push(page, 'delta', {
			turnId: 'compact',
			offset: 0,
			text: 'I found the message. Here is the reply to review.'
		});
		await push(page, 'tool', {
			turnId: 'compact',
			id: 'send-call',
			name: 'send_email',
			summary: 'Send reply to Alex',
			textOffset: 49
		});
		await push(
			page,
			'approval',
			{
				nonce: 'compact-approval',
				view: {
					tool: 'send_email',
					agentId: 'main',
					agentName: 'Main',
					fields: [
						{ key: 'to', value: 'Alex <alex@example.com>', kind: 'single', max: 100 },
						{ key: 'subject', value: 'Updated plan for Friday', kind: 'single', max: 100 },
						{
							key: 'body',
							value:
								'Hi Alex,\nThe plan is ready. I will send the remaining details tomorrow.\nThanks!',
							kind: 'body'
						}
					]
				}
			},
			1
		);
		const request = page.locator('[data-surface="approval"]');
		await expect(request).toHaveCount(1);
		await expect(request).toContainText('Send email');
		await expect(request).toContainText('Subject');
		expect((await request.boundingBox())!.height).toBeLessThan(320);
		await page.screenshot({ path: `/tmp/chat-approval-pending-${width}.png` });
		await page.getByRole('button', { name: 'Approve send_email' }).click();
		await expect(request).toHaveCount(0);
		const call = page.locator('[data-tool-call="send-call"]');
		await expect(call).toContainText('Running');
		await expect(call.locator('summary')).toContainText('Approved');
		await call.locator('summary').click();
		await expect(call).toContainText('Approved');
		await page.screenshot({ path: `/tmp/chat-approval-resolved-${width}.png` });
	});
}

for (const width of [320, 412, 1280]) {
	test(`tool stretches collapse into a category summary at ${width}px`, async ({
		page,
		context
	}) => {
		await chatServer(context);
		await page.setViewportSize({ width, height: 915 });
		await open(page);
		await push(page, 'delta', { turnId: 'grouped', offset: 0, text: 'I will inspect the files.' });
		for (const [id, name] of [
			['read-1', 'read'],
			['read-2', 'read'],
			['bash-1', 'bash']
		]) {
			await push(page, 'tool', {
				turnId: 'grouped',
				id,
				name,
				summary: `${name} ${id}`,
				textOffset: 24,
				input: { command: id }
			});
			await push(page, 'tool', {
				turnId: 'grouped',
				id,
				name,
				summary: `${name} ${id}`,
				textOffset: 24,
				ok: true,
				output: { result: `result ${id}` }
			});
		}
		const group = page.locator('[data-tool-activity]');
		await expect(group).toHaveCount(1);
		await expect(group.locator(':scope > summary')).toContainText('Read × 2');
		await expect(group.locator(':scope > summary')).toContainText('Bash × 1');
		await expect(page.locator('[data-tool-call="read-1"]')).not.toBeVisible();
		expect((await group.locator(':scope > summary').boundingBox())!.height).toBe(48);
		await push(page, 'tool', {
			turnId: 'grouped',
			id: 'bad',
			name: 'bash',
			summary: 'Command failed',
			textOffset: 24,
			ok: false
		});
		await expect(page.locator('[data-tool-call="bad"]')).toBeVisible();
		await expect(page.locator('[data-tool-call="bad"] summary')).toContainText('Failed');
		await group.locator(':scope > summary').click();
		await expect(page.locator('[data-tool-call="read-1"]')).toBeVisible();
		await page.locator('[data-tool-call="read-1"] summary').click();
		await expect(page.locator('[data-tool-call="read-1"]')).toContainText('Input');
		await expect(page.locator('[data-tool-call="read-1"]')).toContainText('read read-1');
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
			)
		).toBe(true);
		await page.screenshot({ path: `/tmp/chat-grouped-tools-${width}.png` });
	});
}

for (const width of [412, 1280]) {
	for (const theme of ['light', 'dark'] as const) {
		test(`typed confirmation follows its call lifecycle at ${width}px in ${theme}`, async ({
			page,
			context
		}) => {
			await chatServer(context);
			await page.setViewportSize({ width, height: 915 });
			await page.emulateMedia({ colorScheme: theme });
			await open(page);
			await push(page, 'delta', { turnId: 'confirm-turn', offset: 0, text: 'Checking status.' });
			await push(
				page,
				'ask',
				{
					key: 'confirm-ask',
					askId: 'confirm-ask',
					question: 'Allow command?',
					choices: ['Yes', 'No'],
					toolConfirmation: {
						tool: 'bash',
						input: 'ws-consolidate --status',
						reason: 'Review the command',
						toolCallId: 'confirm-call'
					}
				},
				1
			);
			const confirmation = page.locator('[data-surface="tool-confirmation"]');
			await expect(confirmation).toContainText('Approval needed');
			await expect(confirmation).toContainText('ws-consolidate --status');
			await page.screenshot({ path: `/tmp/chat-confirmation-pending-${width}-${theme}.png` });
			await confirmation.getByRole('button', { name: 'Approve', exact: true }).click();
			await push(page, 'ask_resolved', { askId: 'confirm-ask', answer: 'Yes' }, 2);
			await expect(confirmation).toContainText('Approved');
			await expect(confirmation.locator('summary')).not.toContainText('Finished');
			await push(page, 'tool', {
				turnId: 'confirm-turn',
				id: 'confirm-call',
				name: 'bash',
				summary: 'ws-consolidate --status',
				textOffset: 16,
				ok: true
			});
			await push(page, 'tool', {
				turnId: 'confirm-turn',
				id: 'next-call',
				name: 'read',
				summary: 'Read next file',
				textOffset: 16
			});
			await expect(confirmation).toHaveCount(0);
			const executed = page.locator('[data-tool-call="confirm-call"]');
			await expect(executed.locator('summary')).toContainText('Approved');
			await expect(executed.locator('summary')).toContainText('Finished');
			await expect(page.locator('[data-tool-call="next-call"]')).toBeVisible();
			expect(
				await page.evaluate(() => {
					const a = document.querySelector('[data-tool-call="confirm-call"]')!;
					const b = document.querySelector('[data-tool-call="next-call"]')!;
					return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
				})
			).toBe(true);
			await page.screenshot({ path: `/tmp/chat-confirmation-resolved-${width}-${theme}.png` });
			await executed.locator('summary').click();
			await expect(executed).toContainText('Reason');
			await expect(executed).toContainText('Review the command');
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
				)
			).toBe(true);
		});
	}
}

test('another-device decision with a long command reflows at 320px', async ({ page, context }) => {
	await chatServer(context);
	await page.setViewportSize({ width: 320, height: 915 });
	await open(page);
	await push(page, 'tool', {
		turnId: 'long-confirm',
		id: 'long-call',
		name: 'bash',
		summary: 'Run a very long command description that must truncate safely'
	});
	await push(
		page,
		'ask',
		{
			key: 'long-ask',
			askId: 'long-ask',
			question: 'Allow?',
			choices: ['Yes', 'No'],
			toolConfirmation: {
				tool: 'bash',
				input: 'printf very-long-command-input',
				toolCallId: 'long-call'
			}
		},
		1
	);
	await push(page, 'ask_resolved', { askId: 'long-ask', answer: 'Yes' }, 2);
	const summary = page.locator('[data-tool-call="long-call"] summary');
	await expect(summary).toContainText('Approved on another device');
	await expect(summary).toContainText('Running');
	expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(48);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		)
	).toBe(true);
});
