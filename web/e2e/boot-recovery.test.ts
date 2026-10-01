import { expect, test, type BrowserContext } from '@playwright/test';

// The root layout's chunk failing to load is the path where SvelteKit falls back to a DOMParser
// error page, which Trusted Types blocks. The preview server enforces the same TT policy.
async function breakRootLayout(context: BrowserContext, failures: number) {
	let failed = 0;
	let documents = 0;
	await context.route('**/api/**', (route) =>
		route.fulfill({ status: 503, contentType: 'application/json', body: '{"offline":true}' })
	);
	await context.route('**/_app/immutable/nodes/0.*', (route) =>
		failed++ < failures ? route.abort() : route.continue()
	);
	context.on('request', (req) => {
		if (req.resourceType() === 'document') documents++;
	});
	return { documents: () => documents };
}

test.use({ serviceWorkers: 'block' });

test('a stale root chunk reloads once and then boots', async ({ page, context }) => {
	const loads = await breakRootLayout(context, 1);
	await page.goto('/');
	await expect.poll(loads.documents).toBe(2);
	await expect(page.locator('body')).toContainText('Home');
	await expect(page.getByRole('heading', { name: "sushii-agent couldn't start" })).toHaveCount(0);
	await page.waitForTimeout(500);
	expect(loads.documents()).toBe(2);
});

test('a root chunk that keeps failing shows a fallback instead of a blank page', async ({
	page,
	context
}) => {
	const loads = await breakRootLayout(context, Infinity);
	await page.goto('/');
	await expect(page.getByRole('heading', { name: "sushii-agent couldn't start" })).toBeVisible();
	const retry = page.getByRole('button', { name: 'Try again' });
	await expect(retry).toBeVisible();
	expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(48);
	// One automatic reload, never a loop.
	await page.waitForTimeout(1_000);
	expect(loads.documents()).toBe(2);
});
