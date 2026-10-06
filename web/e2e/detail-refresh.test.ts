import { expect, test } from '@playwright/test';
import { fixtureApp } from './helpers';

const RUN = '01K6B3A1C3E5G7J9M1P3R5T7V9';

test('failed detail refresh keeps the selected panel and expanded steps mounted through retry', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto(`/runs/${RUN}`);
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	const panel = page.getByRole('tabpanel', { name: 'Activity', exact: true });
	await expect
		.poll(async () => {
			const pane = await panel.boundingBox();
			const viewport = await page.locator('[data-tab-pager]').boundingBox();
			return Math.abs(pane!.x - viewport!.x);
		})
		.toBeLessThan(1);
	const step = panel.getByRole('button', { name: /^Succeeded bash .*python summarize/ });
	await step.click();
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	await page.evaluate(() => document.fonts.ready);
	const mountedStep = await step.elementHandle();
	const before = await step.boundingBox();
	const originalScroll = await panel.evaluate((el) => el.scrollTop);

	let refreshing = false;
	let fail = true;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => (release = resolve));
	await context.route(`**/api/runs/${RUN}`, async (route) => {
		if (!fail) return route.fallback();
		refreshing = true;
		await pending;
		await route.fulfill({ status: 503, json: { error: 'Refresh unavailable' } });
	});
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect.poll(() => refreshing).toBe(true);
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	expect(await mountedStep!.evaluate((el) => el.isConnected)).toBe(true);
	expect((await step.boundingBox())!.y).toBe(before!.y);
	expect(await panel.evaluate((el) => el.scrollTop)).toBe(originalScroll);

	release();
	await expect(panel.getByRole('alert')).toContainText("Couldn't refresh this page.");
	await expect(page.getByRole('alert')).toHaveCount(1);
	await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	expect(await mountedStep!.evaluate((el) => el.isConnected)).toBe(true);
	expect((await step.boundingBox())!.y).toBe(before!.y);
	expect(await panel.evaluate((el) => el.scrollTop)).toBe(originalScroll);

	fail = false;
	const retried = page.waitForResponse(
		(response) => new URL(response.url()).pathname === `/api/runs/${RUN}` && response.ok()
	);
	await panel.getByRole('button', { name: 'Try again' }).click();
	await retried;
	await expect(page.getByRole('alert')).toHaveCount(0);
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	expect(await mountedStep!.evaluate((el) => el.isConnected)).toBe(true);
	await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
});
