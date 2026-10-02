import { expect, test } from '@playwright/test';
import { fixtureApp, push } from './helpers';

// This covers the UI callback boundary. The host separately restricts real location requests to Main.
for (const conversation of ['main', 'oct-trip'] as const) {
	test(`explicit location sharing forwards the browser fix through the ${conversation} conversation callback`, async ({
		page,
		context
	}) => {
		await fixtureApp(context);
		await context.addInitScript(() => {
			(window as unknown as { locationReads: number }).locationReads = 0;
			Object.defineProperty(navigator, 'geolocation', {
				value: {
					getCurrentPosition(success: PositionCallback) {
						(window as unknown as { locationReads: number }).locationReads++;
						success({
							coords: { latitude: 34.123456, longitude: -118.654321, accuracy: 15 },
							timestamp: Date.now()
						} as GeolocationPosition);
					}
				}
			});
		});
		const nonce = 'abcdefghijklmno1';
		const approval = {
			nonce,
			view: {
				tool: 'request_current_location',
				agentId: 'main',
				agentName: 'Main',
				fields: [{ key: 'reason', value: 'Find nearby coffee', kind: 'body' as const }]
			}
		};
		const base = conversation === 'main' ? '/api/chat' : `/api/threads/${conversation}/chat`;
		const posts: { path: string; body: unknown }[] = [];
		await context.route(`**${base}/location/**`, (route) => {
			posts.push({
				path: new URL(route.request().url()).pathname,
				body: route.request().postDataJSON()
			});
			return route.fulfill({ json: { status: 'decided' } });
		});
		await context.route(`**${base}/approvals/**`, (route) => {
			posts.push({
				path: new URL(route.request().url()).pathname,
				body: route.request().postDataJSON()
			});
			return route.fulfill({ status: 403 });
		});
		if (conversation !== 'main') {
			await context.route(`**${base}/stream**`, (route) =>
				route.fulfill({
					contentType: 'text/event-stream',
					body: `event: hello\ndata: ${JSON.stringify({ headSeq: 0, workspace: 'online', openTurns: [], pending: { approvals: [{ ...approval, seq: 1, at: new Date().toISOString() }], asks: [] } })}\n\nid: 1\nevent: approval\ndata: ${JSON.stringify(approval)}\n\n`
				})
			);
		}
		await page.goto(conversation === 'main' ? '/chat' : `/chats/${conversation}`);
		if (conversation === 'main') {
			await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
			await push(page, 'approval', approval, 1);
		}
		const share = page.getByRole('button', { name: 'Approve request_current_location' });
		await expect(share).toBeVisible();
		expect(
			await page.evaluate(() => (window as unknown as { locationReads: number }).locationReads)
		).toBe(0);
		await share.click();
		await expect
			.poll(() => posts)
			.toEqual([
				{
					path: `${base}/location/${nonce}`,
					body: {
						status: 'shared',
						latitude: 34.123456,
						longitude: -118.654321,
						accuracy: 15,
						timestamp: expect.any(Number)
					}
				}
			]);
		await expect(
			page.getByText("This device isn't signed in as the owner.", { exact: true })
		).toHaveCount(0);
		expect(
			await page.evaluate(() => (window as unknown as { locationReads: number }).locationReads)
		).toBe(1);
	});
}
