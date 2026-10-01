import { expect, test, type BrowserContext } from '@playwright/test';
import { checkScreen, fixtureApp } from './helpers';

const MODELS = [
	{ alias: 'sol', backend: 'chatgpt', id: 'gpt-6.1-sol' },
	{ alias: 'or-luna', backend: 'openrouter', id: 'openai/gpt-6-luna' }
];

/** The fixture app with GET/POST /api/models answering from `current`; returns the POST bodies. */
async function withModels(context: BrowserContext, status = 200) {
	await fixtureApp(context, { override: '' });
	let current = 'sol';
	const posts: unknown[] = [];
	await context.route('**/api/models', async (route) => {
		const req = route.request();
		if (status !== 200) return route.fulfill({ status, json: { unsupported: true } });
		if (req.method() === 'POST') {
			const body = req.postDataJSON() as { alias: string };
			posts.push(body);
			current = body.alias;
		}
		return route.fulfill({ json: { current, models: MODELS } });
	});
	return posts;
}

test('the model chip shows the current model, and picking another switches it', async ({
	page,
	context
}) => {
	const posts = await withModels(context);
	await page.goto('/chat');
	const chip = page.getByRole('button', { name: 'Model: sol. Change model' });
	await chip.click();
	const sheet = page.getByRole('dialog', { name: 'Model' });
	await expect(sheet.getByRole('button', { name: /^sol/ })).toHaveAttribute('aria-pressed', 'true');
	await expect(sheet).toContainText('OpenRouter · openai/gpt-6-luna');
	await sheet.getByRole('button', { name: /^or-luna/ }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('button', { name: 'Model: or-luna. Change model' })).toBeVisible();
	expect(posts).toEqual([{ alias: 'or-luna' }]);
});

test('an agent too old to say shows no chip', async ({ page, context }) => {
	await withModels(context, 501);
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Model:/ })).toHaveCount(0);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the composer and the model sheet pass axe, targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await withModels(context);
		await page.goto('/chat');
		await page.getByRole('textbox', { name: 'Message' }).fill('hi');
		await checkScreen(page);
		await page.getByRole('button', { name: /^Model:/ }).click();
		await checkScreen(page);
	});
}
