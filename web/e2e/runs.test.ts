import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fakeBackend, type Scenario } from './fake-backend';
import { axe, horizontalOverflow, push, smallTargets, stubStream } from './helpers';

const RUN = {
	triage: '01K6B4D2F4H6K8M0P2R4T6V8X0',
	nightlySync: '01K6B2N8W3J5Q7R9T1V3X5Z7A9',
	expenses: '01K6B3A1C3E5G7J9M1P3R5T7V9',
	refactor: '01K6AZT2V4X6Z8B0D2F4H6K8M0',
	flush: '01K6AZQ7S9V1X3Z5B7D9F1H3K5'
};

/** The app on fixtures; `runs` picks what the fake backend's Runs routes answer. */
async function server(
	context: BrowserContext,
	runs?: Scenario,
	opts: { features?: Parameters<typeof fakeBackend>[1]['features'] } = {}
) {
	await stubStream(context);
	await context.route('**/api/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/chat/history') return route.fulfill({ json: { items: [], before: null } });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	return fakeBackend(context, { runs, features: opts.features });
}
const rows = (page: Page) => page.getByRole('main').getByRole('listitem');

test('the list groups runs by day, each with its status and what started it', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/runs');
	await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
	const sync = rows(page).filter({ hasText: 'Back up projects to the home server' }).first();
	await expect(sync).toContainText('Failed');
	await expect(sync).toContainText('Scheduled · nightly-sync');
	await expect(rows(page).filter({ hasText: 'Sort new mail' })).toContainText('Running');
	await expect(rows(page).filter({ hasText: 'Book the car service' })).toContainText('Stopped');
	await expect(rows(page).filter({ hasText: 'Compare flight prices' })).toContainText('Timed out');
	await sync.getByRole('link').click();
	await expect(page).toHaveURL(new RegExp(`/runs/${RUN.nightlySync}$`));
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page).toHaveURL(/\/runs$/);
});

test('older runs load under the first page, then point to History', async ({ page, context }) => {
	await server(context);
	await page.goto('/runs');
	await expect(rows(page)).toHaveCount(10);
	await page.getByRole('button', { name: 'Show older runs' }).click();
	await expect(rows(page)).toHaveCount(13);
	await expect(page.getByRole('button', { name: 'Show older runs' })).toBeHidden();
	await expect(page.getByText('Older runs are in History.')).toBeVisible();
});

test('the type filter asks the bot for one kind and shows only those runs', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/runs');
	await expect(rows(page)).toHaveCount(10);
	const asked = page.waitForRequest(
		(r) => new URL(r.url()).searchParams.get('kind') === 'subagent'
	);
	await page.getByRole('radio', { name: 'Background' }).click();
	await asked;
	await expect(rows(page)).toHaveCount(2);
	await expect(rows(page).filter({ hasText: 'Compare flight prices' })).toBeVisible();
	await expect(rows(page).filter({ hasText: 'Book the car service' })).toBeHidden();
	await page.getByRole('radio', { name: 'All' }).click();
	await expect(rows(page)).toHaveCount(10);
});

test('no runs yet says what will appear', async ({ page, context }) => {
	await server(context, 'empty');
	await page.goto('/runs');
	await expect(page.getByText('No runs yet')).toBeVisible();
	await expect(
		page.getByText('Chat turns, scheduled jobs and background work show up here')
	).toBeVisible();
});

test('a slow list shows a labelled skeleton', async ({ page, context }) => {
	await server(context, 'slow');
	await page.goto('/runs');
	await expect(page.getByRole('status').filter({ hasText: 'Loading runs…' })).toBeAttached();
	await expect(rows(page).first()).toBeVisible({ timeout: 6000 });
});

test('a list that fails to load says so and retries', async ({ page, context }) => {
	const backend = await server(context, 'unsupported');
	await page.goto('/runs');
	await expect(page.getByRole('alert')).toContainText(
		"Couldn't load runs. Runs aren't available yet."
	);
	backend.set('runs', 'normal');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(rows(page).first()).toBeVisible();
});

for (const [scenario, text] of [
	['offline', "Can't reach the agent right now."],
	['timeout', 'The agent took too long to answer. Try again.'],
	['bad', "The agent's answer couldn't be read. Try again later."]
] as const) {
	test(`the list says why the agent's answer is missing (${scenario})`, async ({
		page,
		context
	}) => {
		await server(context, scenario);
		await page.goto('/runs');
		await expect(page.getByRole('alert')).toContainText(text);
		await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
	});
}

test('an out-of-date page cursor asks for a reload instead of showing nothing', async ({
	page,
	context
}) => {
	const backend = await server(context);
	await page.goto('/runs');
	await expect(rows(page)).toHaveCount(10);
	backend.set('runs', 'stale');
	await page.getByRole('button', { name: 'Show older runs' }).click();
	await expect(page.getByText('The list changed since it loaded.')).toBeVisible();
	await expect(rows(page)).toHaveCount(10);
	expect(backend.calls.filter((c) => c.path === '/api/runs').at(-1)?.search).toMatch(
		/^\?before=[0-9A-Z]{26}$/
	);
});

test("a run event changes the run's status on screen without a reload", async ({
	page,
	context
}) => {
	const backend = await server(context);
	await page.goto(`/runs/${RUN.triage}`);
	await expect(page.getByText('Still running.')).toBeVisible();
	backend.setRunStatus(RUN.triage, 'failed');
	await push(page, 'run', { runId: RUN.triage, kind: 'subagent', status: 'failed' });
	await expect(page.getByText('Failed. The host recorded an error')).toBeVisible();
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	const triage = rows(page).filter({ hasText: 'Sort new mail' });
	await expect(triage).toContainText('Failed');
	backend.setRunStatus(RUN.triage, 'done');
	await push(page, 'run', { runId: RUN.triage, kind: 'subagent', status: 'done' });
	await expect(triage).toContainText('Done');
});

test('with Runs turned off on the bot, its screens send you Home', async ({ page, context }) => {
	await server(context, undefined, { features: ['history', 'home', 'alerts'] });
	await page.goto(`/runs/${RUN.triage}`);
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
	await page.goto('/more');
	await expect(page.getByRole('link', { name: /History/ })).toBeVisible();
	await expect(page.getByRole('link', { name: /Runs/ })).toBeHidden();
});

test('offline, the list keeps what it had and shows the banner', async ({ page, context }) => {
	await server(context);
	await page.goto('/runs');
	await expect(rows(page).first()).toBeVisible();
	await context.setOffline(true);
	await expect(page.getByText(/offline/i).first()).toBeVisible();
	await expect(rows(page).first()).toBeVisible();
	await context.setOffline(false);
});

test('a finished run shows the host status, evidence and a collapsed timeline', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto(`/runs/${RUN.expenses}`);
	await expect(page.getByText('Draft the quarterly expenses summary')).toBeVisible();
	await expect(page.getByText('Outcome, as the host recorded it')).toBeVisible();
	await expect(
		page.getByText('Finished. That means it ran to the end, not that it worked')
	).toBeVisible();
	await expect(page.getByText('cd projects/finance && bun test').first()).toBeVisible();
	await expect(page.getByText('~/memory/finance.md').first()).toBeVisible();
	await expect(page.getByRole('link', { name: /q3-summary\.pdf/ })).toHaveAttribute(
		'href',
		/^\/f\//
	);
	const step = page.getByRole('button', { name: /^Succeeded bash .*python summarize/ });
	await expect(step).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByText('Wrote q3-summary.md (1,412 words).')).toBeHidden();
	await step.click();
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByText('Wrote q3-summary.md (1,412 words).')).toBeVisible();
	await page.getByRole('link', { name: /Compare flight prices/ }).click();
	await expect(page.getByText('Timed out after 30 minutes.')).toBeVisible();
	await page.getByRole('link', { name: /Draft the quarterly expenses summary/ }).click();
	await expect(page.getByRole('link', { name: /Notes from that day/ })).toHaveAttribute(
		'href',
		/^\/history\/\d{4}-\d{2}-\d{2}$/
	);
});

test('a failed run shows the failing step and its error', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.nightlySync}`);
	await expect(page.getByText('Failed. The host recorded an error')).toBeVisible();
	await expect(
		page.getByText('Job failed: rsync exited with code 30 after 3 tries.')
	).toBeVisible();
	await page.getByRole('button', { name: /^Failed bash .*rsync/ }).click();
	await expect(page.getByText(/ssh: connect to host backup\.lan port 22/)).toBeVisible();
});

test('a running run says it is still going', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.triage}`);
	await expect(page.getByText('Still running.')).toBeVisible();
	await expect(page.getByText('The agent is still working on this run.')).toBeVisible();
	await expect(page.getByRole('button', { name: /^No result label_mail/ })).toBeVisible();
});

test('a long run pages its steps', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.refactor}`);
	await expect(page.getByText('100+ steps', { exact: true })).toBeVisible();
	await expect(page.getByText('No check ran after the last change.')).toBeVisible();
	await page.getByRole('button', { name: 'Show more steps' }).click();
	await expect(page.getByText('162 steps', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show more steps' })).toBeHidden();
});

test('a run without a transcript says why it has no steps', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.flush}`);
	await expect(
		page.getByText("This run's transcript is gone, so there are no steps to show.")
	).toBeVisible();
});

test('an unknown run says it was not found instead of loading forever', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/runs/01K6AAAAAAAAAAAAAAAAAAAAAA');
	await expect(page.getByText('Run not found')).toBeVisible();
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page).toHaveURL(/\/runs$/);
});

test('Open run from a Home peek replaces the sheet, and the run leaves Ready for review', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/');
	await page.getByRole('button', { name: /Draft the quarterly expenses summary/ }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Open run' }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${RUN.expenses}$`));
	await page.goBack();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(page.getByText('Check dependencies for updates')).toBeVisible();
	await expect(page.getByText('Draft the quarterly expenses summary')).toBeHidden();
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`Runs pass axe, 48px targets and reflow in ${colorScheme}`, async ({ page, context }) => {
		await page.emulateMedia({ colorScheme });
		await server(context);
		for (const path of ['/runs', `/runs/${RUN.expenses}`, `/runs/${RUN.refactor}`]) {
			await page.goto(path);
			if (path === '/runs') await expect(rows(page).first()).toBeVisible();
			else {
				await expect(page.getByRole('heading', { name: /Timeline/ })).toBeVisible();
				await page
					.getByRole('button', { name: /^(Succeeded|Failed) / })
					.first()
					.click();
			}
			expect(await axe(page), path).toEqual([]);
			expect(await smallTargets(page), path).toEqual([]);
			for (const width of [412, 320]) {
				await page.setViewportSize({ width, height: 800 });
				expect(await horizontalOverflow(page), `${path} at ${width}px`).toEqual([]);
			}
			await page.setViewportSize({ width: 412, height: 915 });
		}
	});
}
