import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { axe, horizontalOverflow, smallTargets, stubStream } from './helpers';

const ENDPOINT = 'https://push.example.test/sub/abc';
const PUBLIC_KEY =
	'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const KEY_BYTES = [...Buffer.from(PUBLIC_KEY, 'base64url')];

type Call = { method: string; path: string; body: string | null; contentType?: string };
type ApiOptions = {
	meStatus?: number;
	keyStatus?: number;
	subscribeStatus?: number;
	quietStatus?: number;
};

// Context-level, so requests from the service worker are mocked as well as the page's.
async function mockApi(context: BrowserContext, initial: ApiOptions = {}) {
	const opts = {
		meStatus: 200,
		keyStatus: 200,
		subscribeStatus: 200,
		quietStatus: 200,
		...initial
	};
	let quiet = { enabled: false, start: '22:00', end: '08:00' };
	const calls: Call[] = [];
	await stubStream(context);
	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		calls.push({
			method: req.method(),
			path,
			body: req.postData(),
			contentType: req.headers()['content-type']
		});
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (path === '/api/me') {
			if (opts.meStatus !== 200) return route.fulfill({ status: opts.meStatus, body: 'Forbidden' });
			return json({ login: 'drk@example.com' });
		}
		if (path === '/api/push/key') {
			if (opts.keyStatus !== 200) return route.fulfill({ status: opts.keyStatus, body: 'Nope' });
			return json({ publicKey: PUBLIC_KEY });
		}
		if (path === '/api/push/subscribe') {
			if (req.method() === 'POST' && opts.subscribeStatus !== 200) {
				return route.fulfill({ status: opts.subscribeStatus, body: 'Broken' });
			}
			return json({ ok: true });
		}
		if (path === '/api/push/test') return json({ sent: 1, pruned: 0 });
		if (path === '/api/settings/quiet-hours') {
			if (opts.quietStatus !== 200)
				return route.fulfill({ status: opts.quietStatus, body: 'Broken' });
			if (req.method() === 'PUT') quiet = JSON.parse(req.postData() ?? '{}');
			return json({ ...quiet, timeZone: 'Europe/Berlin' });
		}
		if (path === '/api/chat/history') return json({ items: [], before: null });
		if (path === '/api/chat/seen') return route.fulfill({ status: 204 });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	const subscribes = () =>
		calls.filter((c) => c.method === 'POST' && c.path === '/api/push/subscribe');
	return { calls, opts, subscribes };
}

// Headless Chromium has no push service, so PushManager is faked. The subscription lives in
// localStorage so it survives reloads the way a real one does.
async function stubPush(page: Page) {
	await page.addInitScript((endpoint) => {
		const STORE = 'fake-push-sub';
		type Stored = { key: number[] };
		const w = window as unknown as {
			__subscribeCalls: { userVisibleOnly: boolean; key: number[] }[];
			__unsubscribed: number;
		};
		w.__subscribeCalls = [];
		w.__unsubscribed = 0;
		const load = (): Stored | null => JSON.parse(localStorage.getItem(STORE) ?? 'null');
		const make = (stored: Stored) =>
			({
				endpoint,
				options: {
					userVisibleOnly: true,
					applicationServerKey: new Uint8Array(stored.key).buffer
				},
				toJSON: () => ({
					endpoint,
					expirationTime: null,
					keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
				}),
				unsubscribe: async () => {
					localStorage.removeItem(STORE);
					w.__unsubscribed++;
					return true;
				}
			}) as unknown as PushSubscription;
		PushManager.prototype.getSubscription = async () => {
			const stored = load();
			return stored ? make(stored) : null;
		};
		PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
			const key = [...new Uint8Array(options?.applicationServerKey as ArrayBuffer)];
			w.__subscribeCalls.push({ userVisibleOnly: options?.userVisibleOnly ?? false, key });
			localStorage.setItem(STORE, JSON.stringify({ key }));
			return make({ key });
		};
	}, ENDPOINT);
}

async function seedSubscription(page: Page, key: number[]) {
	await page.evaluate(
		(k) => localStorage.setItem('fake-push-sub', JSON.stringify({ key: k })),
		key
	);
}

const subscribeCalls = (page: Page) =>
	page.evaluate(() => (window as unknown as { __subscribeCalls: unknown[] }).__subscribeCalls);

async function controlled(page: Page) {
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

// vite preview serves the bot's Trusted Types directives, so every test also proves the app
// never hands a string to a DOM sink outside its allowlisted policies.
const ttErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	ttErrors.set(page, errors);
	page.on('pageerror', (err) => {
		if (/trusted ?type|TrustedHTML|TrustedScriptURL/i.test(err.message)) errors.push(err.message);
	});
	page.on('console', (msg) => {
		if (/trusted ?type|TrustedHTML|TrustedScript/i.test(msg.text())) errors.push(msg.text());
	});
});
test.afterEach(async ({ page }) => {
	expect(ttErrors.get(page) ?? []).toEqual([]);
});

const toggleOf = (page: Page) => page.getByRole('switch', { name: /notify this device/i });

test('settings shows the signed-in login', async ({ page, context }) => {
	await mockApi(context);
	await stubPush(page);
	await page.goto('/settings');
	await expect(page.getByTestId('login')).toHaveText('drk@example.com');
});

test('quiet hours turn on, take a time range, and show the zone they run in', async ({
	page,
	context
}) => {
	const { calls } = await mockApi(context);
	await stubPush(page);
	await page.goto('/settings');
	const quiet = page.getByRole('switch', { name: /silence replies at night/i });
	await expect(quiet).toHaveAttribute('aria-checked', 'false');
	await quiet.click();
	await expect(quiet).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByTestId('quiet-zone')).toHaveText('Times are in Europe/Berlin.');
	await page.getByLabel('From').fill('23:15');
	await page.getByLabel('From').blur();
	await expect
		.poll(() =>
			calls
				.filter((c) => c.method === 'PUT' && c.path === '/api/settings/quiet-hours')
				.map((c) => JSON.parse(c.body ?? '{}'))
		)
		.toEqual([
			{ enabled: true, start: '22:00', end: '08:00' },
			{ enabled: true, start: '23:15', end: '08:00' }
		]);
	expect(await axe(page)).toEqual([]);
	expect(await smallTargets(page)).toEqual([]);
});

test('a quiet hours save that fails puts the switch back and says so', async ({
	page,
	context
}) => {
	const { opts } = await mockApi(context);
	await stubPush(page);
	await page.goto('/settings');
	const quiet = page.getByRole('switch', { name: /silence replies at night/i });
	await expect(quiet).toBeEnabled();
	opts.quietStatus = 500;
	await quiet.click();
	await expect(page.getByRole('alert')).toContainText("Couldn't save quiet hours.");
	await expect(quiet).toHaveAttribute('aria-checked', 'false');
});

test('turning notifications on subscribes with the server key, and the test button sends', async ({
	page,
	context
}) => {
	await context.grantPermissions(['notifications']);
	const { calls, subscribes } = await mockApi(context);
	await stubPush(page);
	await page.goto('/settings');
	const toggle = toggleOf(page);
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	await expect(toggle).toBeEnabled();

	await toggle.click();
	// The first subscribe waits for the service worker to finish precaching.
	await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
	expect(KEY_BYTES).toHaveLength(65);
	expect(KEY_BYTES[0]).toBe(4);
	expect(await subscribeCalls(page)).toEqual([{ userVisibleOnly: true, key: KEY_BYTES }]);

	const sub = subscribes().at(-1)!;
	expect(sub.contentType).toBe('application/json');
	expect(JSON.parse(sub.body!)).toMatchObject({
		endpoint: ENDPOINT,
		keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
	});

	await page.getByRole('button', { name: 'Send test notification' }).click();
	await expect(page.getByText('Sent to 1 device.')).toBeVisible();
	const sendTest = calls.find((c) => c.path === '/api/push/test')!;
	expect(sendTest.method).toBe('POST');
	expect(sendTest.body).toBeNull();
	expect(sendTest.contentType).toBeUndefined();

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	const del = calls.find((c) => c.method === 'DELETE')!;
	expect(del.contentType).toBe('application/json');
	expect(JSON.parse(del.body!)).toEqual({ endpoint: ENDPOINT });
});

test('a server failure while subscribing rolls the browser subscription back', async ({
	page,
	context
}) => {
	await context.grantPermissions(['notifications']);
	await mockApi(context, { subscribeStatus: 500 });
	await stubPush(page);
	await page.goto('/settings');
	const toggle = toggleOf(page);
	await toggle.click();
	await expect(page.getByRole('alert')).toContainText('The agent had a problem', {
		timeout: 15_000
	});
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	const state = await page.evaluate(() => ({
		unsubscribed: (window as unknown as { __unsubscribed: number }).__unsubscribed,
		stored: localStorage.getItem('fake-push-sub')
	}));
	expect(state).toEqual({ unsubscribed: 1, stored: null });
});

test('the app resends an existing subscription on every start, not only on settings', async ({
	page,
	context
}) => {
	await context.grantPermissions(['notifications']);
	const { subscribes } = await mockApi(context);
	await stubPush(page);
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await seedSubscription(page, KEY_BYTES);
	const before = subscribes().length;

	await page.reload();
	await expect(page.getByText('Say hi to your agent.')).toBeVisible();
	await expect.poll(() => subscribes().length).toBe(before + 1);
	expect(JSON.parse(subscribes().at(-1)!.body!)).toMatchObject({ endpoint: ENDPOINT });
	expect(subscribes().at(-1)!.contentType).toBe('application/json');

	// Landing on settings shares the start-up resend instead of sending a second one.
	await page.goto('/settings');
	await expect(toggleOf(page)).toHaveAttribute('aria-checked', 'true');
	await page.waitForTimeout(500);
	expect(subscribes().length).toBe(before + 2);
});

test('a subscription made with an old server key is replaced on start', async ({
	page,
	context
}) => {
	await context.grantPermissions(['notifications']);
	const { calls, subscribes } = await mockApi(context);
	await stubPush(page);
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await seedSubscription(page, [4, ...new Array(64).fill(7)]);
	await page.reload();
	await expect.poll(() => subscribes().length).toBe(1);
	expect(await subscribeCalls(page)).toEqual([{ userVisibleOnly: true, key: KEY_BYTES }]);
	expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/push/subscribe')).toBe(true);
});

test('a failed resend keeps notifications on, says so, and retries', async ({ page, context }) => {
	await context.grantPermissions(['notifications']);
	const { opts, subscribes } = await mockApi(context, { subscribeStatus: 500 });
	await stubPush(page);
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await seedSubscription(page, KEY_BYTES);
	await page.goto('/settings');

	const toggle = toggleOf(page);
	await expect(toggle).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('status').filter({ hasText: "Couldn't sync" })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send test notification' })).toBeEnabled();

	opts.subscribeStatus = 200;
	const before = subscribes().length;
	await page.evaluate(() => dispatchEvent(new Event('online')));
	await expect.poll(() => subscribes().length).toBe(before + 1);
	await expect(page.getByText("Couldn't sync")).toBeHidden();
	await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('the permission prompt waits until the server has a push key', async ({ page, context }) => {
	await mockApi(context, { keyStatus: 404 });
	await stubPush(page);
	await page.goto('/settings');
	await toggleOf(page).click();
	await expect(page.getByRole('alert')).toContainText("aren't set up on the server");
	expect(await page.evaluate(() => Notification.permission)).toBe('default');
});

test('denying the prompt shows the blocked help, and allowing it later re-enables the switch', async ({
	page,
	context
}) => {
	await mockApi(context);
	await stubPush(page);
	await page.goto('/settings');
	const toggle = toggleOf(page);
	await expect(toggle).toBeEnabled();
	// Headless Chromium answers an unanswered prompt with "denied".
	await toggle.click();
	await expect(page.getByText('Turn notifications back on')).toBeVisible();
	await expect(toggle).toBeDisabled();
	await expect(toggle).toContainText('Blocked');

	await context.grantPermissions(['notifications']);
	await expect(toggle).toBeEnabled();
	await expect(page.getByText('Turn notifications back on')).toBeHidden();
	await expect(toggle).toContainText('Off for this device');
});

test('without permission change events, coming back to the app re-checks the block', async ({
	page,
	context
}) => {
	await mockApi(context);
	await stubPush(page);
	await page.addInitScript(() => {
		Permissions.prototype.query = () => Promise.reject(new TypeError('unsupported'));
	});
	await page.goto('/settings');
	const toggle = toggleOf(page);
	await toggle.click();
	await expect(toggle).toContainText('Blocked');
	await expect(toggle).toBeDisabled();

	await context.grantPermissions(['notifications']);
	await page.waitForTimeout(300);
	await expect(toggle).toBeDisabled();
	await page.evaluate(() => dispatchEvent(new Event('focus')));
	await expect(toggle).toBeEnabled();
});

test('a failed account load says so and offers a retry', async ({ page, context }) => {
	await mockApi(context, { meStatus: 403 });
	await stubPush(page);
	await page.goto('/settings');
	await expect(page.getByRole('alert')).toContainText("isn't signed in as the owner");
	await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('going offline shows the banner', async ({ page, context }) => {
	await mockApi(context);
	await page.goto('/');
	await expect(page.getByText('Say hi to your agent.')).toBeVisible();
	await context.setOffline(true);
	await expect(page.getByText('Offline. Messages send when you reconnect.')).toBeVisible();
	await context.setOffline(false);
	await expect(page.getByText('Offline. Messages send when you reconnect.')).toBeHidden();
});

test('the reflow check catches content wider than the screen', async ({ page, context }) => {
	await mockApi(context);
	await page.goto('/');
	await expect(page.getByText('Say hi to your agent.')).toBeVisible();
	await page.setViewportSize({ width: 320, height: 800 });
	expect(await horizontalOverflow(page)).toEqual([]);
	await page.evaluate(() => {
		const wide = document.createElement('div');
		wide.id = 'too-wide';
		wide.style.width = '600px';
		wide.style.height = '10px';
		document.querySelector('main')!.append(wide);
	});
	// The document never grows, which is why a documentElement check alone proves nothing here.
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		)
	).toBeLessThanOrEqual(0);
	const offenders = await horizontalOverflow(page);
	expect(offenders.some((o) => o.startsWith('div#too-wide'))).toBe(true);
	expect(offenders.some((o) => o.startsWith('main') && o.includes('scrolls'))).toBe(true);
});

for (const colorScheme of ['light', 'dark'] as const) {
	for (const path of ['/', '/settings']) {
		test(`${path} passes axe, 48px targets and reflow in ${colorScheme}`, async ({
			page,
			context
		}) => {
			await page.emulateMedia({ colorScheme });
			await mockApi(context);
			await stubPush(page);
			await page.goto(path);
			if (path === '/settings') await expect(page.getByTestId('login')).toBeVisible();
			else await expect(page.getByText('Say hi to your agent.')).toBeVisible();

			expect(await axe(page)).toEqual([]);
			expect(await smallTargets(page)).toEqual([]);

			for (const width of [412, 320]) {
				await page.setViewportSize({ width, height: 800 });
				expect(await horizontalOverflow(page), `overflow at ${width}px`).toEqual([]);
			}
		});
	}
}

test('the theme choices move with the arrow keys', async ({ page, context }) => {
	await mockApi(context);
	await stubPush(page);
	await page.goto('/settings');
	const group = page.getByRole('radiogroup', { name: 'Appearance' });
	const system = group.getByRole('radio', { name: 'System' });
	const light = group.getByRole('radio', { name: 'Light' });
	await expect(system).toHaveAttribute('tabindex', '0');
	await expect(light).toHaveAttribute('tabindex', '-1');
	await system.focus();
	await page.keyboard.press('ArrowRight');
	await expect(light).toBeFocused();
	await expect(light).toHaveAttribute('aria-checked', 'true');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowLeft');
	await expect(group.getByRole('radio', { name: 'Dark' })).toBeFocused();
});

test('the precached shell opens while offline', async ({ page, context }) => {
	await mockApi(context);
	await page.goto('/');
	await controlled(page);
	await context.setOffline(true);
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(page.getByText(/You're offline/)).toBeVisible();
});

test('a 502 from the proxy during a restart still opens the cached shell', async ({
	page,
	context
}) => {
	await mockApi(context);
	await page.goto('/');
	await controlled(page);
	await context.route('**/settings', (route) =>
		route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad gateway' })
	);
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(page.getByTestId('login')).toHaveText('drk@example.com');
});

test('a 403 page from the proxy is shown as is', async ({ page, context }) => {
	await mockApi(context);
	await page.goto('/');
	await controlled(page);
	await context.route('**/settings', (route) =>
		route.fulfill({ status: 403, contentType: 'text/plain', body: 'Not the owner' })
	);
	await page.goto('/settings');
	await expect(page.getByText('Not the owner')).toBeVisible();
});

async function pushChannel(page: Page, context: BrowserContext) {
	const cdp = await context.newCDPSession(page);
	const registered = new Promise<string>((resolve) => {
		cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
			const reg = registrations.find((r) => !r.isDeleted);
			if (reg) resolve(reg.registrationId);
		});
	});
	await cdp.send('ServiceWorker.enable');
	const registrationId = await registered;
	// Chromium opens a context's notification store lazily, and a showNotification racing another read or
	// write during that first open can be dropped even though its promise resolves. Open it first.
	await page.evaluate(async () => (await navigator.serviceWorker.ready).getNotifications());
	const origin = new URL(page.url()).origin;
	return (payload: unknown) =>
		cdp.send('ServiceWorker.deliverPushMessage', {
			origin,
			registrationId,
			data: JSON.stringify(payload)
		});
}

const shownNotifications = (page: Page) =>
	page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		return (await reg.getNotifications()).map((n) => ({
			title: n.title,
			body: n.body,
			tag: n.tag,
			data: n.data,
			silent: n.silent,
			requireInteraction: n.requireInteraction,
			renotify: n.renotify
		}));
	});

test('a push message shows a notification from the service worker', async ({ page, context }) => {
	await context.grantPermissions(['notifications']);
	await mockApi(context);
	await page.goto('/');
	await controlled(page);
	const push = await pushChannel(page, context);
	await push({ title: 'Run failed', body: 'Nightly sync', url: '/settings', tag: 'r1' });
	await expect
		.poll(async () =>
			(await shownNotifications(page)).map(({ title, body, tag, data }) => ({
				title,
				body,
				tag,
				data
			}))
		)
		.toEqual([
			{ title: 'Run failed', body: 'Nightly sync', tag: 'r1', data: { url: '/settings' } }
		]);
});

test('a push honours its flags and never keeps a cross-origin url', async ({ page, context }) => {
	await context.grantPermissions(['notifications']);
	await mockApi(context);
	await page.goto('/settings');
	await controlled(page);
	const push = await pushChannel(page, context);
	await push({
		title: 'Approval needed',
		body: 'run bash',
		url: 'https://evil.example/?approve=n1',
		tag: 'approval:n1',
		requireInteraction: true,
		renotify: true
	});
	await push({
		title: 'Reply',
		body: 'night',
		url: '/api/chat/stream',
		tag: 'quiet',
		silent: true
	});
	await expect
		.poll(async () => (await shownNotifications(page)).sort((a, b) => a.tag.localeCompare(b.tag)))
		.toEqual([
			{
				title: 'Approval needed',
				body: 'run bash',
				tag: 'approval:n1',
				data: { url: '/' },
				silent: false,
				requireInteraction: true,
				renotify: true
			},
			{
				title: 'Reply',
				body: 'night',
				tag: 'quiet',
				data: { url: '/' },
				silent: true,
				requireInteraction: false,
				renotify: false
			}
		]);
});

test('opening Main closes the chat notification and leaves others', async ({ page, context }) => {
	await context.grantPermissions(['notifications']);
	await mockApi(context);
	await page.goto('/settings');
	await controlled(page);
	const push = await pushChannel(page, context);
	await push({ title: 'sushii-agent', body: 'done', url: '/', tag: 'chat' });
	await push({ title: 'Other', body: 'x', url: '/', tag: 'other' });
	await expect.poll(async () => (await shownNotifications(page)).length).toBe(2);
	await page.goto('/');
	await expect
		.poll(async () => (await shownNotifications(page)).map((n) => n.tag))
		.toEqual(['other']);
});

test('the settings back chevron returns without stacking history', async ({ page, context }) => {
	await mockApi(context);
	await stubPush(page);
	await page.goto('/');
	await page.getByRole('link', { name: 'Settings' }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await page.getByRole('link', { name: 'Back to Main' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByText('Say hi to your agent.')).toBeVisible();
	await page.goBack();
	await expect(page).not.toHaveURL(/\/settings$/);
});

test('opening settings directly throws nothing', async ({ page, context }) => {
	await mockApi(context);
	await stubPush(page);
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/settings');
	await expect(page.getByRole('link', { name: 'Back to Main' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('the app runs under enforced Trusted Types with only its own policies', async ({
	page,
	context
}) => {
	await mockApi(context);
	await stubPush(page);
	const res = await page.goto('/');
	expect(res?.headers()['content-security-policy']).toContain("require-trusted-types-for 'script'");
	await expect(page.getByText('Say hi to your agent.')).toBeVisible();
	await page.evaluate(() => navigator.serviceWorker.ready);
	const probe = await page.evaluate(() => {
		const tt = (
			window as unknown as { trustedTypes: { createPolicy(n: string, r: object): unknown } }
		).trustedTypes;
		const tryIt = (f: () => unknown) => {
			try {
				f();
				return 'allowed';
			} catch {
				return 'blocked';
			}
		};
		return {
			innerHTML: tryIt(() => (document.createElement('div').innerHTML = '<b>x</b>')),
			policy: tryIt(() => tt.createPolicy('evil', { createHTML: (s: string) => s }))
		};
	});
	expect(probe).toEqual({ innerHTML: 'blocked', policy: 'blocked' });
	// The probe's own violations are expected; anything after it is not.
	ttErrors.get(page)?.splice(0);
	await page.getByRole('link', { name: 'Settings' }).click();
	await expect(page.getByTestId('login')).toHaveText('drk@example.com');
});
