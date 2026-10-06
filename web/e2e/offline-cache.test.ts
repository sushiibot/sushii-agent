import { expect, test, type Page } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';
async function cachedPaths(page: Page) {
	return page.evaluate(async () => {
		if (!(await indexedDB.databases()).some((d) => d.name === 'agent-offline' && d.version === 1))
			return [];
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const r = indexedDB.open('agent-offline', 1);
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error);
		});
		try {
			return await new Promise<string[]>((resolve, reject) => {
				const r = db.transaction('responses').objectStore('responses').getAllKeys();
				r.onsuccess = () => resolve(r.result as string[]);
				r.onerror = () => reject(r.error);
			});
		} finally {
			db.close();
		}
	});
}
for (const colorScheme of ['light', 'dark'] as const) {
	test(`saved threads survive a fully offline reload in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await fixtureApp(context);
		await page.goto('/chats');
		await expect(page.getByRole('heading', { name: 'Threads', level: 1 })).toBeVisible();
		await expect
			.poll(() => cachedPaths(page))
			.toEqual(
				expect.arrayContaining([
					'/chats',
					'/threads/oct-trip',
					'/threads/oct-trip/chat/history?limit=40',
					'/chat/history?limit=40'
				])
			);
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		await page.reload();
		await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
		await context.route('**/api/**', (route) => route.abort('internetdisconnected'));
		await context.setOffline(true);
		await page.reload();
		await expect(
			page.getByText("You're offline. Browsing saved threads on this device.")
		).toBeVisible();
		await page.getByRole('link', { name: /October trip/ }).click();
		await expect(page.getByRole('heading', { name: 'October trip', level: 1 })).toBeVisible();
		await expect(page.getByText('Picking up the trip here.')).toBeVisible();
		await page.reload();
		await expect(page.getByText('Picking up the trip here.')).toBeVisible();
		await checkScreen(page);
		await page.screenshot({ path: `test-results/offline-thread-${colorScheme}.png` });
	});
}
test('network fallback does not hide a live permission refusal', async ({ page, context }) => {
	await fixtureApp(context);
	await page.goto('/chats/oct-trip');
	await expect(page.getByText('Picking up the trip here.')).toBeVisible();
	await context.route('**/api/threads/oct-trip', (route) =>
		route.fulfill({ status: 403, body: 'Forbidden' })
	);
	await page.reload();
	await expect(
		page.getByText("This device isn't signed in as the owner. Check Tailscale.")
	).toBeVisible();
	await expect.poll(() => cachedPaths(page)).not.toContain('/threads/oct-trip');
});

test('old snapshots remain available when the gateway is unreachable', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats/oct-trip');
	await expect(page.getByText('Picking up the trip here.')).toBeVisible();
	await expect
		.poll(
			async () =>
				(await cachedPaths(page)).filter(
					(p) => p.includes('/threads/') && p.includes('/chat/history?')
				).length
		)
		.toBe(7);
	await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve) => {
			const r = indexedDB.open('agent-offline', 1);
			r.onsuccess = () => resolve(r.result);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('responses', 'readwrite');
			const store = tx.objectStore('responses');
			const r = store.getAll();
			r.onsuccess = () => {
				for (const row of r.result) store.put({ ...row, savedAt: 0 });
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	});
	await context.route('**/api/**', (route) => route.abort('internetdisconnected'));
	await page.reload();
	await expect(page.getByText('Picking up the trip here.')).toBeVisible();
	await expect.poll(() => cachedPaths(page)).toContain('/threads/oct-trip');
});
