import { expect, test, type BrowserContext } from '@playwright/test';
import { checkScreen, fixtureApp, push } from './helpers';

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

test('Stop sits beside Send while a turn runs, so steering never lands on Stop', async ({
	page,
	context
}) => {
	await withModels(context);
	await page.goto('/chat');
	await expect(page.getByRole('button', { name: /^Model:/ })).toBeVisible();
	await push(page, 'snapshot', {
		turnId: 't1',
		view: { turnId: 't1', startedAt: Date.now(), lines: [], toolCount: 0, text: '' }
	});
	const stop = page.getByRole('button', { name: 'Stop' });
	const send = page.getByRole('button', { name: 'Send message' });
	await expect(stop).toBeVisible();
	await expect(send).toBeDisabled();
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
		'placeholder',
		'Steer the agent…'
	);
	await page.getByRole('textbox', { name: 'Message' }).fill('also check X');
	await expect(stop).toBeVisible();
	await expect(send).toBeEnabled();
	expect((await stop.boundingBox())!.x).toBeLessThan((await send.boundingBox())!.x);
});

test('a model the list no longer has says so and reloads the list', async ({ page, context }) => {
	await fixtureApp(context, { override: '' });
	let sets = 0;
	await context.route('**/api/models', (route) => {
		if (route.request().method() === 'POST') {
			sets++;
			return route.fulfill({ status: 409, json: { error: 'unknown_model' } });
		}
		return route.fulfill({
			json: { current: 'sol', models: sets ? MODELS.slice(0, 1) : MODELS }
		});
	});
	await page.goto('/chat');
	await page.getByRole('button', { name: /^Model:/ }).click();
	const sheet = page.getByRole('dialog', { name: 'Model' });
	await sheet.getByRole('button', { name: /^or-luna/ }).click();
	await expect(sheet.getByRole('alert')).toContainText('no longer on the list');
	await expect(sheet.getByRole('button', { name: /^or-luna/ })).toHaveCount(0);
});
