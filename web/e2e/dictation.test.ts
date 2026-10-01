import { expect, test, type BrowserContext } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

test.use({
	launchOptions: {
		args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
	},
	permissions: ['microphone']
});

/** The fixture app with dictation on; the bot's transcript is `text`, or a 422 when null. */
async function withDictation(context: BrowserContext, text: string | null) {
	await fixtureApp(context, { override: '' });
	const posts: string[] = [];
	await context.route('**/api/me', (route) =>
		route.fulfill({ json: { login: 'drk@example.com', features: [], dictation: true } })
	);
	await context.route('**/api/dictation', async (route) => {
		posts.push(route.request().headers()['content-type'] ?? '');
		if (text === null) return route.fulfill({ status: 422, json: { error: 'no_speech' } });
		return route.fulfill({ json: { text } });
	});
	return posts;
}

test('the mic records, shows a timer, and adds the transcript to the draft', async ({
	page,
	context
}) => {
	const posts = await withDictation(context, 'and book the 7pm table');
	await page.goto('/chat');
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('Thanks.');
	await page.getByRole('button', { name: 'Dictate' }).click();
	const stop = page.getByRole('button', { name: 'Stop dictating' });
	await expect(stop).toBeVisible();
	await expect(page.getByText(/^0:0[1-9]$/)).toBeVisible();
	await checkScreen(page);
	await page.setViewportSize({ width: 412, height: 915 });
	await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
	await stop.click();
	await expect(box).toHaveValue('Thanks. and book the 7pm table');
	await expect(page.getByRole('button', { name: 'Dictate' })).toBeEnabled();
	expect(posts).toHaveLength(1);
	expect(posts[0]).toMatch(/^audio\//);
});

test('no words says so and leaves the draft alone', async ({ page, context }) => {
	await withDictation(context, null);
	await page.goto('/chat');
	await page.getByRole('button', { name: 'Dictate' }).click();
	await page.getByRole('button', { name: 'Stop dictating' }).click();
	await expect(page.getByRole('alert')).toContainText("Didn't catch any words");
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

test('a bot without dictation shows no mic', async ({ page, context }) => {
	await fixtureApp(context, { override: '' });
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Dictate' })).toHaveCount(0);
});

test('leaving the app mid-recording ends the take and transcribes it, with the mic released', async ({
	page,
	context
}) => {
	const posts = await withDictation(context, 'note to self');
	await page.goto('/chat');
	await page.getByRole('button', { name: 'Dictate' }).click();
	await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible();
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('note to self');
	expect(posts).toHaveLength(1);
});

test('a recorder that stops on its own still ends the take instead of hanging', async ({
	page,
	context
}) => {
	await withDictation(context, 'cut short');
	await page.goto('/chat');
	await page.evaluate(() => {
		const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async (c) => {
			const stream = await real(c);
			(window as unknown as { __track: MediaStreamTrack }).__track = stream.getAudioTracks()[0]!;
			return stream;
		};
	});
	await page.getByRole('button', { name: 'Dictate' }).click();
	await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible();
	await page.waitForTimeout(300);
	await page.evaluate(() => {
		const t = (window as unknown as { __track: MediaStreamTrack }).__track;
		t.stop();
		t.dispatchEvent(new Event('ended'));
	});
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('cut short');
	await expect(page.getByRole('button', { name: 'Dictate' })).toBeEnabled();
});
