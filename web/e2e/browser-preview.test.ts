import { readFileSync } from 'node:fs';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { fixtureApp, checkScreen } from './helpers';

// A controlled local page captured at the browser's real viewport size.
const image = readFileSync(new URL('./fixtures/browser-preview.png', import.meta.url)).toString(
	'base64'
);
const frame = { seq: 1, data: image, width: 1280, height: 800, capturedAt: Date.now() };
const initial = {
	id: 'task-browser-1',
	conversationId: 'main',
	state: 'active' as 'starting' | 'active' | 'ended',
	runId: 'run-one',
	url: 'https://example.com/billing',
	action: 'Reading page'
};

async function preview(page: Page, conversationId = 'main') {
	await fixtureApp(page.context(), { override: '' });
	let status = { ...initial, conversationId };
	const sockets: WebSocketRoute[] = [];
	const closed: WebSocketRoute[] = [];
	const packets: unknown[] = [];
	await page.route('**/api/browser/status**', (route) => route.fulfill({ json: { status } }));
	await page.routeWebSocket('**/api/browser/connect**', (socket) => {
		sockets.push(socket);
		socket.onClose(() => closed.push(socket));
		let awaitingFrame = true;
		socket.onMessage((raw) => {
			const packet = JSON.parse(String(raw));
			packets.push(packet);
			if (packet.type === 'ack') {
				if (!awaitingFrame || packet.seq !== frame.seq) socket.close({ code: 1008 });
				awaitingFrame = false;
			}
		});
		socket.send(JSON.stringify({ type: 'status', status }));
		socket.send(JSON.stringify({ type: 'frame', id: status.id, ...frame }));
	});
	return {
		sockets,
		closed,
		packets,
		set: (next: Partial<typeof initial>) => {
			status = { ...status, ...next };
		},
		sendStatus: () => sockets.at(-1)?.send(JSON.stringify({ type: 'status', status })),
		disconnect: () => sockets.at(-1)?.close({ code: 1013 })
	};
}

test('live preview opens automatically, hide stops streaming, expand and Android Back preserve chat', async ({
	page
}) => {
	const stream = await preview(page);
	await page.goto('/chat');
	const region = page.getByRole('region', { name: 'Browser preview' });
	await expect(region.getByRole('img')).toBeVisible();
	await expect(region).toContainText('Live');
	await expect.poll(() => stream.packets.some((p: any) => p.type === 'ack')).toBe(true);
	await checkScreen(page);
	await page.screenshot({ path: '/tmp/sushii-browser-mobile.png' });
	await region.getByRole('button', { name: 'Hide browser preview' }).click();
	await expect(region.getByRole('img')).toBeHidden();
	await expect.poll(() => stream.closed.length).toBe(1);
	await page.waitForTimeout(1200);
	expect(stream.sockets).toHaveLength(1);
	await region.getByRole('button', { name: 'Show', exact: true }).click();
	await expect(region.getByRole('img')).toBeVisible();
	await region.getByRole('button', { name: 'Expand browser preview' }).click();
	const viewer = page.getByRole('dialog', { name: /example\.com/ });
	await expect(viewer).toBeVisible();
	await expect.poll(() => stream.sockets.at(-1)?.url()).toContain('fps=15');
	await checkScreen(page);
	await viewer.getByRole('button', { name: 'Details', exact: true }).click();
	await expect(viewer).toContainText('https://example.com/billing');
	await viewer.getByRole('button', { name: 'Zoom browser screen' }).click();
	await expect(viewer.getByRole('button', { name: 'Fit browser screen' })).toBeVisible();
	await page.goBack();
	await expect(viewer).toBeHidden();
	await expect(region.getByRole('img')).toBeVisible();
	await expect.poll(() => stream.sockets.at(-1)?.url()).toContain('fps=5');
});

test('hide survives navigation and reconnection, but a different task opens its preview', async ({
	page
}) => {
	const stream = await preview(page);
	await page.goto('/chat');
	const region = page.getByRole('region', { name: 'Browser preview' });
	await expect(region.getByRole('img')).toBeVisible();
	stream.disconnect();
	await expect(region).toContainText('Reconnecting');
	await region.getByRole('button', { name: 'Hide browser preview' }).click();
	await page.getByRole('button', { name: /^Menu/ }).click();
	await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await page.getByRole('button', { name: /^Menu/ }).click();
	await page
		.getByRole('navigation')
		.getByRole('link', { name: /^Conversations/ })
		.click();
	await page.getByRole('link', { name: /^Main chat/ }).click();
	await expect(region.getByRole('button', { name: 'Show', exact: true })).toBeVisible();
	await expect(region.getByRole('img')).toBeHidden();
	stream.set({ id: 'task-browser-2', url: 'https://two.example/download' });
	await expect(region.getByRole('img')).toBeVisible();
	await expect(region).toContainText('two.example');
});

test('topic previews request their conversation and never show another conversation’s browser', async ({
	page
}) => {
	const stream = await preview(page, 'oct-trip');
	await page.goto('/chats/oct-trip');
	const region = page.getByRole('region', { name: 'Browser preview' });
	await expect(region.getByRole('img')).toBeVisible();
	await expect.poll(() => stream.sockets.at(-1)?.url()).toContain('conversation=oct-trip');
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await page.waitForTimeout(1200);
	await expect(region).toHaveCount(0);
});

test('completion collapses the inline view and keeps an expanded last frame until dismissed', async ({
	page
}) => {
	const stream = await preview(page);
	await page.goto('/chat');
	const region = page.getByRole('region', { name: 'Browser preview' });
	await expect(region.getByRole('img')).toBeVisible();
	stream.set({ state: 'ended' });
	stream.sendStatus();
	await expect(region).toContainText('Finished');
	await expect(region.getByRole('img')).toBeHidden({ timeout: 7000 });
	stream.set({ id: 'task-browser-2', state: 'active' });
	await expect(region.getByRole('img')).toBeVisible();
	await region.getByRole('button', { name: 'Expand browser preview' }).click();
	const viewer = page.getByRole('dialog', { name: /example\.com/ });
	await expect(viewer).toBeVisible();
	stream.set({ state: 'ended' });
	stream.sendStatus();
	await expect(viewer).toContainText('Finished');
	await page.waitForTimeout(5500);
	await expect(viewer.getByRole('img')).toBeVisible();
	await viewer.getByRole('button', { name: 'Close browser screen' }).click();
	await expect(viewer).toBeHidden();
	await expect(region.getByRole('img')).toBeHidden();
});

test('a quiet page stays live and reconnect acknowledges an unchanged frame', async ({ page }) => {
	const stream = await preview(page);
	await page.goto('/chat');
	const region = page.getByRole('region', { name: 'Browser preview' });
	await expect(region.getByRole('img')).toBeVisible();
	for (let i = 0; i < 6; i++) {
		stream.sendStatus();
		await page.waitForTimeout(1000);
	}
	await expect(region).toContainText('Live');
	expect(stream.packets.filter((p: any) => p.type === 'ping').length).toBeGreaterThan(0);
	const ackCount = stream.packets.filter((p: any) => p.type === 'ack').length;
	stream.disconnect();
	await expect.poll(() => stream.sockets.length).toBe(2);
	await expect
		.poll(() => stream.packets.filter((p: any) => p.type === 'ack').length)
		.toBeGreaterThan(ackCount);
});

test('preview fits desktop and narrow phones without covering the composer', async ({ page }) => {
	await preview(page);
	await page.goto('/chat');
	const region = page.getByRole('region', { name: 'Browser preview' });
	await expect(region.getByRole('img')).toBeVisible();
	for (const width of [320, 1280]) {
		await page.setViewportSize({ width, height: 915 });
		await checkScreen(page);
		if (width === 1280) await page.screenshot({ path: '/tmp/sushii-browser-desktop.png' });
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	}
});
