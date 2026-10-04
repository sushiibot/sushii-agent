import { expect, test, type BrowserContext } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';
test.use({
	launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
	permissions: ['microphone']
});
async function withVoice(context: BrowserContext, configured = true) {
	await fixtureApp(context, { override: '' });
	await context.route('**/api/voice/models', (route) =>
		route.fulfill({
			json: {
				models: [
					{
						id: 'qwen',
						name: 'Qwen Omni Flash',
						model: 'qwen3.8-omni-flash-realtime',
						inputRate: 16000,
						audioInputUsd: 0.93,
						audioOutputUsd: 1.87,
						configured
					}
				],
				defaultProvider: configured ? 'qwen' : null
			}
		})
	);
}
test('voice keeps Dictate available and explains missing server credentials', async ({
	page,
	context
}) => {
	await withVoice(context, false);
	await page.goto('/chat');
	await expect(page.getByRole('button', { name: 'Dictate' })).toBeEnabled();
	await page.getByRole('button', { name: 'Voice chat', exact: true }).click();
	await expect(
		page.getByText('Voice needs a provider API key on the server.', { exact: false })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Start voice chat' })).toBeDisabled();
	await checkScreen(page);
});
test('PCM streams in both directions, interruption stops playback, mute and end release the mic', async ({
	page,
	context
}) => {
	await withVoice(context);
	let connection: any;
	const packets: any[] = [];
	await page.routeWebSocket('**/api/voice/connect**', (ws) => {
		connection = ws;
		ws.onMessage((data) => packets.push(JSON.parse(String(data))));
		ws.send(JSON.stringify({ type: 'ready', inputRate: 16000 }));
	});
	await page.addInitScript(() => {
		const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async (constraints) => {
			const stream = await real(constraints);
			(window as unknown as { voiceTrack: MediaStreamTrack }).voiceTrack =
				stream.getAudioTracks()[0]!;
			return stream;
		};
	});
	await page.goto('/chat');
	await page.getByRole('button', { name: 'Voice chat', exact: true }).click();
	await page.getByRole('button', { name: 'Start voice chat' }).click();
	await expect(page.getByRole('button', { name: 'Mute microphone' })).toBeEnabled();
	await expect.poll(() => packets.some((m) => m.type === 'audio')).toBe(true);
	connection.send(
		JSON.stringify({
			type: 'audio',
			audio: Buffer.alloc(48000).toString('base64'),
			sampleRate: 24000
		})
	);
	await expect(page.getByText('Speaking — interrupt anytime', { exact: false })).toBeVisible();
	connection.send(JSON.stringify({ type: 'interrupted' }));
	await expect(page.getByText('Listening', { exact: false })).toBeVisible();
	connection.send(JSON.stringify({ type: 'agent', state: 'working' }));
	await expect(
		page.getByText('Sushii is working — you can keep talking', { exact: false })
	).toBeVisible();
	await page.setViewportSize({ width: 320, height: 740 });
	await checkScreen(page);
	await page.getByRole('button', { name: 'Mute microphone' }).click();
	expect(
		await page.evaluate(
			() => (window as unknown as { voiceTrack: MediaStreamTrack }).voiceTrack.enabled
		)
	).toBe(false);
	await page.getByRole('button', { name: 'Back to chat' }).click();
	await expect(page.getByRole('dialog', { name: 'Voice chat' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Dictate' })).toBeDisabled();
	await page.getByRole('button', { name: 'End call' }).click();
	await expect(page.getByRole('button', { name: 'Dictate' })).toBeEnabled();
	expect(
		await page.evaluate(
			() => (window as unknown as { voiceTrack: MediaStreamTrack }).voiceTrack.readyState
		)
	).toBe('ended');
});
test('leaving the app ends the call and releases the microphone', async ({ page, context }) => {
	await withVoice(context);
	await page.routeWebSocket('**/api/voice/connect**', (ws) =>
		ws.send(JSON.stringify({ type: 'ready', inputRate: 16000 }))
	);
	await page.goto('/chat');
	await page.getByRole('button', { name: 'Voice chat', exact: true }).click();
	await page.getByRole('button', { name: 'Start voice chat' }).click();
	await expect(page.getByRole('button', { name: 'Mute microphone' })).toBeEnabled();
	await page.evaluate(() => {
		Object.defineProperty(document, 'hidden', { value: true, configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect(page.getByRole('button', { name: 'Start voice chat' })).toBeEnabled();
});
