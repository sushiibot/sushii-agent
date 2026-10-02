import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fakeBackend } from './fake-backend';
import { axe, horizontalOverflow, smallTargets, stubStream } from './helpers';

/** The app on fixtures; `opts` picks what the fake backend's History and search routes answer. */
async function server(context: BrowserContext, opts: Parameters<typeof fakeBackend>[1] = {}) {
	await stubStream(context);
	await context.route('**/api/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/chat/history') return route.fulfill({ json: { items: [], before: null } });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	return fakeBackend(context, opts);
}

const today = (page: Page) =>
	page.evaluate(() => {
		const d = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	});
const rows = (page: Page) => page.getByRole('main').getByRole('listitem');
const field = (page: Page) => page.getByRole('searchbox', { name: 'Search chat and notes' });

test('the day list groups days by month and opens a day', async ({ page, context }) => {
	await server(context);
	await page.goto('/history');
	await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
	await expect(rows(page)).toHaveCount(10);
	await expect(rows(page).first()).toContainText('Today');
	await expect(rows(page).first()).toContainText('3 recaps · 9 runs');
	await expect(rows(page).first()).toContainText('$0.54 cost');
	await expect(rows(page).nth(1)).toContainText('$0.34 cost · partial');
	await expect(rows(page).nth(3)).toContainText('Cost unavailable');
	await page.getByRole('button', { name: 'Show older days' }).click();
	await expect(rows(page)).toHaveCount(12);
	await rows(page).first().getByRole('link').click();
	await expect(page).toHaveURL(new RegExp(`/history/${await today(page)}$`));
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page).toHaveURL(/\/history$/);
});

test("a day shows the agent's recaps as safe markdown and that day's runs", async ({
	page,
	context
}) => {
	await server(context);
	await page.goto(`/history/${await today(page)}`);
	await expect(page.getByRole('heading', { name: 'Invoice from Eastside Auto' })).toBeVisible();
	await expect(page.getByText('$0.54 cost', { exact: true })).toBeVisible();
	await expect(page.locator('strong', { hasText: 'invoice #1042' })).toBeVisible();
	const planted = page.getByRole('article').filter({ hasText: 'A planted image' });
	await expect(planted).toContainText('<b>raw html</b>');
	await expect(planted.locator('img, b')).toHaveCount(0);
	await expect(
		page.getByRole('link', { name: /Back up projects to the home server/ })
	).toBeHidden();
	await page.getByRole('tab', { name: /^Runs/ }).click();
	await expect(page.getByRole('heading', { name: 'Invoice from Eastside Auto' })).toBeHidden();
	const run = page.getByRole('link', { name: /Back up projects to the home server/ });
	await expect(run).toContainText('Failed');
	await run.click();
	await expect(page).toHaveURL(/\/runs\/01K6B2N8W3J5Q7R9T1V3X5Z7A9$/);
});

test('a day whose notes were cut off says so', async ({ page, context }) => {
	await server(context);
	const yesterday = await page.evaluate(() => {
		const d = new Date(Date.now() - 86_400_000);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	});
	await page.goto(`/history/${yesterday}`);
	await expect(page.getByText("This day's notes are longer than the app reads")).toBeVisible();
});

test('a day with nothing kept says so instead of loading forever', async ({ page, context }) => {
	await server(context);
	for (const path of ['/history/2019-01-01', '/history/not-a-date']) {
		await page.goto(path);
		await expect(page.getByText('No notes for this day')).toBeVisible();
	}
});

test('no notes yet says what will appear', async ({ page, context }) => {
	await server(context, { history: 'empty' });
	await page.goto('/history');
	await expect(page.getByText('No notes yet')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Search chat and notes' })).toBeVisible();
});

test('a slow day list shows a labelled skeleton; an error offers Retry', async ({
	page,
	context
}) => {
	const backend = await server(context, { history: 'slow' });
	await page.goto('/history');
	await expect(page.getByRole('status').filter({ hasText: 'Loading history…' })).toBeAttached();
	await expect(rows(page).first()).toBeVisible({ timeout: 6000 });
	backend.set('history', 'offline');
	await page.goto('/history/2019-01-02');
	await expect(page.getByRole('alert')).toContainText(
		"Couldn't load this day. Can't reach the agent right now."
	);
	backend.set('history', 'normal');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('No notes for this day')).toBeVisible();
});

test('search finds chat and notes, labels each source and highlights the match', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/history');
	await page.getByRole('link', { name: 'Search chat and notes' }).click();
	await expect(page).toHaveURL(/\/history\/search$/);
	await expect(field(page)).toBeFocused();
	await expect(page.getByText('Type at least two characters.')).toBeVisible();
	await field(page).fill('eastside');
	await expect(page).toHaveURL(/\/history\/search\?q=eastside$/);
	await expect(rows(page)).toHaveCount(6);
	await expect(rows(page).filter({ hasText: 'Chat · you' }).first()).toBeVisible();
	await expect(rows(page).filter({ hasText: 'Day notes' }).first()).toBeVisible();
	const emoji = rows(page).filter({ hasText: '🚗' });
	await expect(emoji.locator('mark')).toHaveText('Eastside');
	await rows(page).filter({ hasText: 'brake job' }).getByRole('link').click();
	await expect(page).toHaveURL(/\/history\/\d{4}-\d{2}-\d{2}$/);
	await page.goBack();
	await expect(field(page)).toHaveValue('eastside');
	await expect(rows(page)).toHaveCount(6);
});

test('typing searches once it pauses, and never below two characters', async ({
	page,
	context
}) => {
	const backend = await server(context);
	await page.goto('/history/search');
	const searches = () => backend.calls.filter((c) => c.path === '/api/search');
	await field(page).pressSequentially('e', { delay: 30 });
	await page.waitForTimeout(600);
	expect(searches()).toEqual([]);
	await field(page).pressSequentially('astside', { delay: 40 });
	await expect(rows(page)).toHaveCount(6);
	expect(searches().map((c) => c.search)).toEqual(['?q=eastside']);
});

test('a search with no matches says so', async ({ page, context }) => {
	await server(context);
	await page.goto('/history/search?q=zebra%20crossing');
	await expect(page.getByText('No results for “zebra crossing”')).toBeVisible();
});

test('a capped search says matches may be missing', async ({ page, context }) => {
	await server(context, { search: 'truncated' });
	await page.goto('/history/search?q=eastside');
	await expect(
		page.getByText('Search stopped early, so some matches may be missing.')
	).toBeVisible();
});

test('a source that could not be searched is named', async ({ page, context }) => {
	await server(context, { search: 'unsupported' });
	await page.goto('/history/search?q=eastside');
	await expect(page.getByText("Run notes couldn't be searched just now")).toBeVisible();
	await expect(rows(page).filter({ hasText: 'Day notes' })).toHaveCount(0);
	await expect(rows(page).filter({ hasText: 'Chat' }).first()).toBeVisible();
});

test('a search that fails offers Retry', async ({ page, context }) => {
	const backend = await server(context, { search: 'error' });
	await page.goto('/history/search?q=eastside');
	await expect(page.getByRole('alert')).toContainText("Couldn't search.");
	backend.set('search', 'normal');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(rows(page)).toHaveCount(6);
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`History passes axe, 48px targets and reflow in ${colorScheme}`, async ({
		page,
		context
	}) => {
		await page.emulateMedia({ colorScheme });
		await server(context);
		const day = await today(page);
		for (const path of ['/history', `/history/${day}`, '/history/search?q=eastside']) {
			await page.goto(path);
			if (path === `/history/${day}`) {
				await expect(page.getByRole('tabpanel', { name: 'Recaps', exact: true })).toBeVisible();
			} else {
				await expect(page.getByRole('main').getByRole('link').first()).toBeVisible();
			}
			expect(await axe(page), path).toEqual([]);
			expect(await smallTargets(page), path).toEqual([]);
			for (const width of [412, 320]) {
				await page.setViewportSize({ width, height: 800 });
				expect(await horizontalOverflow(page), `${path} at ${width}px`).toEqual([]);
			}
			await page.setViewportSize({ width: 412, height: 915 });
			if (path === `/history/${day}`) {
				await page.getByRole('tab', { name: /^Runs/ }).click();
				expect(await axe(page), `${path} runs`).toEqual([]);
				expect(await smallTargets(page), `${path} runs`).toEqual([]);
				for (const width of [412, 320]) {
					await page.setViewportSize({ width, height: 800 });
					expect(await horizontalOverflow(page), `${path} runs at ${width}px`).toEqual([]);
				}
				await page.setViewportSize({ width: 412, height: 915 });
			}
		}
	});
}
