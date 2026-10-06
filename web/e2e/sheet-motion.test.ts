import { expect, test, type Page } from '@playwright/test';
import { fixtureApp } from './helpers';

interface MotionCapture {
	opacity: number;
	distance: number;
	height: number;
	animations: number;
}
type MotionWindow = Window & {
	__sheetMotion: Promise<MotionCapture>;
	__sheetExitFinished: boolean;
};

/** Sample the last visible frame while Bits still retains the closing element. */
async function captureExit(page: Page) {
	await page.evaluate(() => {
		const sheet = document.querySelector<HTMLElement>('[data-routed-sheet][data-state="open"]')!;
		const original = sheet.getBoundingClientRect();
		(window as MotionWindow).__sheetMotion = new Promise((resolve) => {
			const observer = new MutationObserver(() => {
				if (sheet.dataset.state !== 'closed') return;
				observer.disconnect();
				requestAnimationFrame(() => {
					const animations = sheet.getAnimations();
					for (const animation of animations) {
						animation.pause();
						animation.currentTime = Number(animation.effect!.getTiming().duration) * 0.99;
					}
					const result = {
						opacity: Number(getComputedStyle(sheet).opacity),
						distance: sheet.getBoundingClientRect().top - original.top,
						height: original.height,
						animations: animations.length
					};
					for (const animation of animations) animation.finish();
					resolve(result);
				});
			});
			observer.observe(sheet, { attributes: true, attributeFilter: ['data-state'] });
		});
	});
}

for (const desktop of [false, true]) {
	test(`a ${desktop ? 'desktop dialog fades' : 'phone sheet slides fully'} before dismissal`, async ({
		page,
		context
	}) => {
		await fixtureApp(context);
		if (desktop) await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/chats');
		await page.getByRole('button', { name: 'New conversation' }).click();
		const sheet = page.getByRole('dialog', { name: 'Start a conversation' });
		await expect(sheet).toBeVisible();
		// Capture geometry after entrance has completed, so exit distance is meaningful.
		await sheet.evaluate(async (element) => {
			await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
		});
		await captureExit(page);
		await page.keyboard.press('Escape');
		const sample = await page.evaluate(() => (window as MotionWindow).__sheetMotion);
		expect(sample.animations).toBeGreaterThan(0);
		expect(sample.opacity).toBeLessThan(0.05);
		if (desktop) expect(Math.abs(sample.distance)).toBeLessThan(24);
		else expect(sample.distance).toBeGreaterThan(sample.height * 0.9);
		await expect(sheet).toBeHidden();
	});
}

test('starting a thread completes the sheet exit before changing routes', async ({
	page,
	context
}) => {
	await fixtureApp(context);
	await page.goto('/chats');
	await page.getByRole('button', { name: 'New conversation' }).click();
	const sheet = page.getByRole('dialog', { name: 'Start a conversation' });
	await sheet.getByRole('textbox', { name: 'Conversation name' }).fill('Motion continuity');
	await sheet.evaluate((element) => {
		(window as MotionWindow).__sheetExitFinished = false;
		element.addEventListener('animationend', () => {
			if ((element as HTMLElement).dataset.state === 'closed')
				(window as MotionWindow).__sheetExitFinished = true;
		});
	});
	await sheet.getByRole('button', { name: 'Start conversation', exact: true }).click();
	await expect(page).toHaveURL(/\/chats\/motion-continuity$/);
	expect(await page.evaluate(() => (window as MotionWindow).__sheetExitFinished)).toBe(true);
});

test('reduced motion dismisses without animating or delaying navigation', async ({
	page,
	context
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await fixtureApp(context);
	await page.goto('/chats');
	await page.getByRole('button', { name: 'New conversation' }).click();
	const sheet = page.getByRole('dialog', { name: 'Start a conversation' });
	await expect(sheet).toBeVisible();
	expect(await sheet.evaluate((element) => element.getAnimations().length)).toBe(0);
	expect(
		await page
			.locator('[data-slot="sheet-overlay"]')
			.evaluate((element) => element.getAnimations().length)
	).toBe(0);
	await sheet.getByRole('textbox', { name: 'Conversation name' }).fill('Reduced motion');
	await sheet.getByRole('button', { name: 'Start conversation', exact: true }).click();
	await expect(page).toHaveURL(/\/chats\/reduced-motion$/);
	await expect(sheet).toBeHidden();
});
