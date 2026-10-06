import { expect, test } from '@playwright/test';
import { fixtureApp } from './helpers';

for (const touch of [true, false]) {
	for (const width of [412, 1280]) {
		test.describe(`${touch ? 'touch' : 'desktop'} composer at ${width}px`, () => {
			test.use({ isMobile: touch, hasTouch: touch, viewport: { width, height: 915 } });

			for (const conversation of ['main', 'oct-trip']) {
				test(`Enter ${touch ? 'inserts a newline' : 'sends'} in ${conversation}`, async ({
					page,
					context
				}) => {
					await fixtureApp(context);
					const base = conversation === 'main' ? '/api/chat' : `/api/threads/${conversation}/chat`;
					const posts: { text: string }[] = [];
					await context.route(`**${base}/messages`, (route) => {
						posts.push(route.request().postDataJSON());
						return route.fulfill({ status: 202, json: { seq: 1, routed: true } });
					});
					await page.goto(conversation === 'main' ? '/chat' : `/chats/${conversation}`);
					const composer = page.getByRole('textbox', { name: 'Message' });
					await composer.fill('First line');
					await composer.press('End');
					if (touch) {
						await composer.press('Enter');
						await expect(composer).toHaveValue('First line\n');
					} else {
						// IME confirmation must not send, including Safari's legacy keyCode signal.
						for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
							expect(
								await composer.evaluate((el, composing) => {
									return el.dispatchEvent(
										new KeyboardEvent('keydown', {
											key: 'Enter',
											bubbles: true,
											cancelable: true,
											...composing
										})
									);
								}, composing)
							).toBe(true);
						}
						await composer.press('Shift+Enter');
						await expect(composer).toHaveValue('First line\n');
					}
					await composer.press('L');
					await expect(composer).toHaveValue('First line\nL');
					expect(posts).toEqual([]);
					if (touch) await page.getByRole('button', { name: 'Send message' }).click();
					else await composer.press('Enter');
					await expect.poll(() => posts.map((post) => post.text)).toEqual(['First line\nL']);
					await expect(composer).toHaveValue('');
				});
			}
		});
	}
}
