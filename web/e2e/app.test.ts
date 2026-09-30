import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ENDPOINT = 'https://push.example.test/sub/abc';

async function mockApi(page: Page, { meStatus = 200 } = {}) {
	const calls: { method: string; path: string; body: unknown }[] = [];
	await page.route('**/api/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
		calls.push({ method: req.method(), path, body });
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
		if (path === '/api/me') {
			if (meStatus !== 200) return route.fulfill({ status: meStatus, body: 'Forbidden' });
			return json({ login: 'drk@example.com' });
		}
		if (path === '/api/push/key')
			return json({
				publicKey:
					'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
			});
		if (path === '/api/push/subscribe') return json({ ok: true });
		if (path === '/api/push/test') return json({ sent: 1, pruned: 0 });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	return calls;
}

// Headless Chromium has no push service and reports notifications as denied, so both are stubbed.
async function stubPush(page: Page) {
	await page.addInitScript((endpoint) => {
		Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
		Notification.requestPermission = async () => 'granted';
		let current: PushSubscription | null = null;
		const fake = {
			endpoint,
			toJSON: () => ({
				endpoint,
				expirationTime: null,
				keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
			}),
			unsubscribe: async () => {
				current = null;
				return true;
			}
		} as unknown as PushSubscription;
		PushManager.prototype.getSubscription = async () => current;
		PushManager.prototype.subscribe = async () => (current = fake);
	}, ENDPOINT);
}

async function smallTargets(page: Page) {
	return page.$$eval(
		'a, button, [role=button], [role=switch], [role=radio], input, textarea, summary',
		(els) =>
			els
				.filter((e) => !(e.tagName === 'A' && e.closest('p')))
				.map((e) => ({ e, r: e.getBoundingClientRect() }))
				.filter(({ r }) => r.width > 0 && (r.width < 48 || r.height < 48))
				.map(({ e }) => e.outerHTML.slice(0, 100))
	);
}

async function axe(page: Page) {
	const results = await new AxeBuilder({ page })
		.options({ rules: { 'target-size': { enabled: true } } })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();
	const ran = [
		...results.passes,
		...results.violations,
		...results.incomplete,
		...results.inapplicable
	];
	expect(ran.some((r) => r.id === 'target-size')).toBe(true);
	return results.violations.map(
		(v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
	);
}

test('settings shows the signed-in login', async ({ page }) => {
	await mockApi(page);
	await stubPush(page);
	await page.goto('/settings');
	await expect(page.getByTestId('login')).toHaveText('drk@example.com');
});

test('turning notifications on subscribes, and the test button sends', async ({ page }) => {
	const calls = await mockApi(page);
	await stubPush(page);
	await page.goto('/settings');
	const toggle = page.getByRole('switch', { name: /notify this device/i });
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	await expect(toggle).toBeEnabled();

	await toggle.click();
	// The first subscribe waits for the service worker to finish precaching.
	await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
	const sub = calls.find((c) => c.method === 'POST' && c.path === '/api/push/subscribe');
	expect(sub?.body).toMatchObject({
		endpoint: ENDPOINT,
		keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
	});

	await page.getByRole('button', { name: 'Send test notification' }).click();
	await expect(page.getByText('Sent to 1 device.')).toBeVisible();

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-checked', 'false');
	expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({ endpoint: ENDPOINT });
});

test('a failed account load says so and offers a retry', async ({ page }) => {
	await mockApi(page, { meStatus: 403 });
	await stubPush(page);
	await page.goto('/settings');
	await expect(page.getByRole('alert')).toContainText("isn't signed in as the owner");
	await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('going offline shows the banner', async ({ page, context }) => {
	await mockApi(page);
	await page.goto('/');
	await expect(page.getByText('Say hi to your agent.')).toBeVisible();
	await context.setOffline(true);
	await expect(page.getByText(/You're offline/)).toBeVisible();
	await context.setOffline(false);
	await expect(page.getByText(/You're offline/)).toBeHidden();
});

for (const colorScheme of ['light', 'dark'] as const) {
	for (const path of ['/', '/settings']) {
		test(`${path} passes axe, 48px targets and reflow in ${colorScheme}`, async ({ page }) => {
			await page.emulateMedia({ colorScheme });
			await mockApi(page);
			await stubPush(page);
			await page.goto(path);
			if (path === '/settings') await expect(page.getByTestId('login')).toBeVisible();
			else await expect(page.getByText('Say hi to your agent.')).toBeVisible();

			expect(await axe(page)).toEqual([]);
			expect(await smallTargets(page)).toEqual([]);

			for (const width of [412, 320]) {
				await page.setViewportSize({ width, height: 800 });
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth
				);
				expect(overflow, `horizontal scroll at ${width}px`).toBeLessThanOrEqual(0);
			}
		});
	}
}

test('the precached shell opens while offline', async ({ page, context }) => {
	await mockApi(page);
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
	await page.reload();
	await context.setOffline(true);
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await expect(page.getByText(/You're offline/)).toBeVisible();
});
