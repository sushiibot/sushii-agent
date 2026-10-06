import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { runDetailPage } from '../src/lib/features/runs/fixtures';
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
	opts: Pick<Parameters<typeof fakeBackend>[1], 'now'> = {}
) {
	await stubStream(context);
	await context.route('**/api/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/chat/history') return route.fulfill({ json: { items: [], before: null } });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	return fakeBackend(context, { runs, ...opts });
}
const rows = (page: Page) => page.getByRole('main').getByRole('listitem');

test('the list groups runs by day, each with its status and what started it', async ({
	page,
	context
}) => {
	// Relative fixtures and the browser share a fixed midday, including when CI runs at midnight.
	const now = new Date('2026-10-02T19:00:00Z');
	await page.clock.setFixedTime(now);
	await server(context, undefined, { now: now.getTime() });
	await page.goto('/runs');
	await expect(page.getByRole('heading', { name: 'Work', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
	const sync = rows(page).filter({ hasText: 'Back up projects to the home server' }).first();
	await expect(sync).toContainText('Failed');
	await expect(sync).toContainText('Scheduled · nightly-sync');
	await expect(rows(page).filter({ hasText: 'Sort new mail' })).toContainText('Running');
	await expect(rows(page).filter({ hasText: 'Book the car service' })).toHaveCount(0);
	await expect(rows(page).filter({ hasText: 'Compare flight prices' })).toContainText('Timed out');
	await sync.getByRole('link').click();
	await expect(page).toHaveURL(new RegExp(`/runs/${RUN.nightlySync}$`));
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page).toHaveURL(/\/runs$/);
});

test('older runs load under the first page, then point to History', async ({ page, context }) => {
	await server(context);
	await page.goto('/runs');
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(rows(page)).toHaveCount(10);
	await page.getByRole('button', { name: 'Show older activity' }).click();
	await expect(rows(page)).toHaveCount(13);
	await expect(page.getByRole('button', { name: 'Show older activity' })).toBeHidden();
	await expect(page.getByText('Older activity is in History.')).toBeVisible();
});

test('the type filter asks the bot for one kind and shows only those runs', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/runs');
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(rows(page)).toHaveCount(10);
	const asked = page.waitForRequest(
		(r) => new URL(r.url()).searchParams.get('kind') === 'subagent'
	);
	await page.getByRole('tab', { name: 'Delegated' }).click();
	await asked;
	await expect(rows(page)).toHaveCount(2);
	await expect(rows(page).filter({ hasText: 'Compare flight prices' })).toBeVisible();
	await expect(rows(page).filter({ hasText: 'Book the car service' })).toBeHidden();
	await expect(page.getByText('Assignments from another agent.')).toBeVisible();
	await page.getByRole('tab', { name: 'Replies', exact: true }).click();
	await expect(
		page.getByText('Continue the conversation in chat.', { exact: false })
	).toBeVisible();
	await expect(rows(page).first()).toContainText('Reply');
	await expect(rows(page).first()).toContainText('Main conversation');
	await page.getByRole('tab', { name: 'Activity' }).click();
	await expect(rows(page)).toHaveCount(10);
});

test('no runs yet says what will appear', async ({ page, context }) => {
	await server(context, 'empty');
	await page.goto('/runs');
	await expect(page.getByText('No tasks yet')).toBeVisible();
	await expect(page.getByText('Delegated and scheduled tasks appear here.')).toBeVisible();
});

test('a slow list shows a labelled skeleton', async ({ page, context }) => {
	await server(context, 'slow');
	await page.goto('/runs');
	await expect(page.getByRole('status').filter({ hasText: 'Loading work…' })).toBeAttached();
	await expect(rows(page).first()).toBeVisible({ timeout: 6000 });
});

test('a list that fails to load says so and retries', async ({ page, context }) => {
	const backend = await server(context, 'unsupported');
	await page.goto('/runs');
	await expect(page.getByRole('alert')).toContainText(
		"Couldn't load work. Work activity isn't available yet."
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
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(rows(page)).toHaveCount(10);
	backend.set('runs', 'stale');
	await page.getByRole('button', { name: 'Show older activity' }).click();
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
	await page.getByRole('tab', { name: 'Results', exact: true }).click();
	await expect(page.getByText('Still running.')).toBeVisible();
	backend.setRunStatus(RUN.triage, 'failed');
	await push(page, 'run', { runId: RUN.triage, kind: 'subagent', status: 'failed' });
	await expect(page.getByText('Failed. An error ended this attempt')).toBeVisible();
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	const triage = rows(page).filter({ hasText: 'Sort new mail' });
	await expect(triage).toContainText('Failed');
	backend.setRunStatus(RUN.triage, 'done');
	await push(page, 'run', { runId: RUN.triage, kind: 'subagent', status: 'done' });
	await expect(triage).toContainText('Finished');
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
	await page.getByRole('tab', { name: 'Results', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible();
	await expect(
		page.getByText('Execution finished. Review the result and recorded checks below.')
	).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeHidden();
	await page.getByRole('tab', { name: 'Results', exact: true }).click();
	const evidence = page.getByRole('tabpanel', { name: 'Results', exact: true });
	await expect(
		evidence.getByText('cd projects/finance && bun test', { exact: true })
	).toBeVisible();
	await expect(evidence.getByText('~/memory/finance.md', { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: /q3-summary\.pdf/ })).toHaveAttribute(
		'href',
		/^\/f\//
	);
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	const step = page.getByRole('button', { name: /^Succeeded bash .*python summarize/ });
	await expect(step).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByText('Wrote q3-summary.md (1,412 words).')).toBeHidden();
	await step.click();
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByText('Wrote q3-summary.md (1,412 words).')).toBeVisible();
	await page.getByRole('tab', { name: 'Details', exact: true }).click();
	await page.getByRole('link', { name: /Compare flight prices/ }).click();
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(page.getByText('Timed out after 30 minutes.')).toBeVisible();
	await page.getByRole('tab', { name: 'Details', exact: true }).click();
	await page.getByRole('link', { name: /Draft the quarterly expenses summary/ }).click();
	await page.getByRole('tab', { name: 'Details', exact: true }).click();
	await expect(page.getByRole('link', { name: /Notes from that day/ })).toHaveAttribute(
		'href',
		/^\/history\/\d{4}-\d{2}-\d{2}$/
	);
});

test('a failed run shows the failing step and its error', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.nightlySync}`);
	await page.getByRole('tab', { name: 'Results', exact: true }).click();
	await expect(page.getByText('Failed. An error ended this attempt')).toBeVisible();
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(
		page
			.getByRole('tabpanel', { name: 'Activity', exact: true })
			.getByText('Job failed: rsync exited with code 30 after 3 tries.')
	).toBeVisible();
	await page.getByRole('button', { name: /^Failed bash .*rsync/ }).click();
	await expect(page.getByText(/ssh: connect to host backup\.lan port 22/)).toBeVisible();
});

test('a running run says it is still going', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.triage}`);
	await page.getByRole('tab', { name: 'Results', exact: true }).click();
	await expect(page.getByText('Still running.')).toBeVisible();
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(page.getByText('Oldest first · tool details expand in place.')).toBeVisible();
	await expect(page.getByRole('button', { name: /^No result label_mail/ })).toBeVisible();
});

test('a long run pages its steps', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.refactor}`);
	await page.getByRole('tab', { name: 'Results', exact: true }).click();
	await expect(page.getByText('No check ran after the last change.')).toBeVisible();
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(page.getByText('100+ steps', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Show more steps' }).click();
	await expect(page.getByText('162 steps', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show more steps' })).toBeHidden();
});

test('a run without a transcript says why it has no steps', async ({ page, context }) => {
	await server(context);
	await page.goto(`/runs/${RUN.flush}`);
	await page.getByRole('tab', { name: 'Activity', exact: true }).click();
	await expect(
		page.getByText('The transcript is gone, so there are no steps to show.')
	).toBeVisible();
});

test('an unknown run says it was not found instead of loading forever', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/runs/01K6AAAAAAAAAAAAAAAAAAAAAA');
	await expect(page.getByText('Activity not found')).toBeVisible();
	await page.getByRole('link', { name: 'Back', exact: true }).click();
	await expect(page).toHaveURL(/\/runs$/);
});

test('View activity from a Home peek replaces the sheet, and the run stays in the inbox as read', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto('/inbox');
	await page.locator('details[data-inbox="shared"] > summary').click();
	await page.getByRole('button', { name: /Draft the quarterly expenses summary/ }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'View activity' }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${RUN.expenses}$`));
	await page.goBack();
	await expect(page).toHaveURL(/\/chats$/);
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(
		page.getByRole('button', { name: /Read: Draft the quarterly expenses summary/ })
	).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
	for (const path of ['/runs', `/runs/${RUN.expenses}`, `/runs/${RUN.refactor}`]) {
		test(`Runs ${path} passes axe, 48px targets and reflow in ${colorScheme}`, async ({
			page,
			context
		}) => {
			await page.emulateMedia({ colorScheme });
			await server(context);
			await page.goto(path);
			if (path === '/runs') await expect(rows(page).first()).toBeVisible();
			else {
				await page.getByRole('tab', { name: 'Activity', exact: true }).click();
				await expect(page.getByRole('heading', { name: /Activity/ })).toBeVisible();
				await page
					.getByRole('button', { name: /^(Succeeded|Failed) / })
					.first()
					.click();
			}
			if (path !== '/runs') {
				for (const section of ['Results', 'Details']) {
					await page.getByRole('tab', { name: section, exact: true }).click();
					expect(await axe(page), `${path} ${section}`).toEqual([]);
					expect(await smallTargets(page), `${path} ${section}`).toEqual([]);
					await page.screenshot({
						path: `/tmp/work-view-${path.endsWith(RUN.expenses) ? 'task' : 'long'}-${section}-${colorScheme}-mobile.png`
					});
					await page.setViewportSize({ width: 320, height: 800 });
					expect(await horizontalOverflow(page), `${path} ${section} at 320px`).toEqual([]);
					await page.setViewportSize({ width: 412, height: 915 });
				}
				await page.getByRole('tab', { name: 'Activity', exact: true }).click();
			}
			expect(await axe(page), path).toEqual([]);
			expect(await smallTargets(page), path).toEqual([]);
			for (const width of [412, 320]) {
				await page.setViewportSize({ width, height: 800 });
				expect(await horizontalOverflow(page), `${path} at ${width}px`).toEqual([]);
			}
			await page.setViewportSize({ width: 412, height: 915 });
			await page.screenshot({
				path: `/tmp/work-view-${path === '/runs' ? 'list' : path.endsWith(RUN.expenses) ? 'task' : 'long'}-${colorScheme}-mobile.png`
			});
			await page.setViewportSize({ width: 1280, height: 915 });
			await page.screenshot({
				path: `/tmp/work-view-${path === '/runs' ? 'list' : path.endsWith(RUN.expenses) ? 'task' : 'long'}-${colorScheme}-desktop.png`
			});
		});
	}
}

test('activity sections support keyboard navigation and preserve expanded steps', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto(`/runs/${RUN.expenses}`);
	const activity = page.getByRole('tab', { name: 'Activity', exact: true });
	const results = page.getByRole('tab', { name: 'Results', exact: true });
	const step = page.getByRole('button', { name: /^Succeeded bash .*python summarize/ });
	await step.click();
	await activity.focus();
	await page.keyboard.press('ArrowRight');
	await expect(results).toBeFocused();
	await expect(results).toHaveAttribute('aria-selected', 'true');
	await expect(step).toBeHidden();
	await activity.click();
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	await activity.focus();
	await page.keyboard.press('End');
	await expect(page.getByRole('tab', { name: 'Details', exact: true })).toBeFocused();
	await page.keyboard.press('Home');
	await expect(activity).toBeFocused();
});

test('running status chips animate in list and detail, and respect reduced motion', async ({
	page,
	context
}) => {
	await server(context);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await page.goto('/runs');
	const listIcon = rows(page)
		.filter({ hasText: 'Sort new mail' })
		.getByText('Running', { exact: true })
		.locator('svg');
	await expect(listIcon).toHaveCSS('animation-name', 'spin');
	await page.goto(`/runs/${RUN.triage}`);
	const detailIcon = page.getByText('Running', { exact: true }).locator('svg');
	await expect(detailIcon).toHaveCSS('animation-name', 'spin');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(detailIcon).toHaveCSS('animation-name', 'none');
});

test('a long brief stays in Details while the heading and tabs remain compact', async ({
	page,
	context
}) => {
	await server(context);
	const detail = runDetailPage(Date.now(), RUN.expenses)!;
	const title =
		'Check whether anything needs attention right now: something due or overdue, a follow-up you promised, an open task that needs a nudge, or a change worth flagging. Read the project notes and recent daily entries before deciding what to do.';
	await context.route(`**/api/runs/${RUN.expenses}`, (route) =>
		route.fulfill({
			json: {
				...detail,
				run: { ...detail.run, title },
				steps: detail.steps.map((step, index) => (index === 0 ? { ...step, text: title } : step))
			}
		})
	);
	await page.goto(`/runs/${RUN.expenses}`);
	await expect(page.getByText('writer task', { exact: true })).toBeVisible();
	await expect(page.locator('[data-tab-panel="overview"]')).toHaveAttribute('aria-hidden', 'true');
	const tabs = await page.getByRole('tablist', { name: 'Activity sections' }).boundingBox();
	expect(tabs!.y).toBeLessThan(300);
	await page.getByRole('tab', { name: 'Details', exact: true }).click();
	await expect(
		page.getByRole('tabpanel', { name: 'Details', exact: true }).getByText(title, { exact: true })
	).toBeVisible();
});

test('Work defaults to tasks while reply cycles and maintenance stay in Activity', async ({
	page,
	context
}) => {
	const backend = await server(context);
	await page.goto('/runs');
	await expect(page.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(rows(page)).toHaveCount(8);
	expect(backend.calls.find((call) => call.path === '/api/runs')?.search).toBe(
		'?kind=job%2Csubagent%2Cagent'
	);
	await expect(rows(page).filter({ hasText: 'invoice from Eastside' })).toHaveCount(0);
	await expect(rows(page).filter({ hasText: 'Memory save' })).toHaveCount(0);
	await page.getByRole('tab', { name: 'Replies', exact: true }).click();
	await expect(rows(page)).toHaveCount(3);
	await rows(page).first().getByRole('link').click();
	await expect(page.getByRole('heading', { name: 'Reply activity', level: 1 })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open conversation' })).toHaveAttribute(
		'href',
		'/chat'
	);
	await page.getByRole('tab', { name: 'Details', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Request', exact: true })).toBeVisible();
});

test('completion preserves chronological activity and the selected section', async ({
	page,
	context
}) => {
	const backend = await server(context);
	await page.goto(`/runs/${RUN.triage}`);
	const activity = page.locator('[data-run-activity]');
	await expect(activity).toBeVisible();
	const before = await activity.locator('li').allTextContents();
	await page.getByRole('button', { name: /^Succeeded search_mail/ }).click();
	backend.setRunStatus(RUN.triage, 'done');
	await push(page, 'run', { runId: RUN.triage, kind: 'job', status: 'done' });
	await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.getByRole('button', { name: /^Succeeded search_mail/ })).toHaveAttribute(
		'aria-expanded',
		'true'
	);
	expect(await activity.locator('li').allTextContents()).toEqual(before);
});

test('a finished reply keeps ongoing delegation visible', async ({ page, context }) => {
	await server(context);
	const detail = runDetailPage(Date.now(), RUN.expenses)!;
	await context.route(`**/api/runs/${RUN.expenses}`, (route) =>
		route.fulfill({
			json: {
				...detail,
				children: detail.children.map((child) => ({ ...child, status: 'running' }))
			}
		})
	);
	await page.goto(`/runs/${RUN.expenses}`);
	await expect(
		page.getByRole('status').filter({ hasText: '1 delegated task is still running.' })
	).toBeVisible();
	await page.getByRole('button', { name: 'Delegated tasks · 1' }).click();
	await expect(page.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await expect(page.getByRole('link', { name: /Compare flight prices/ })).toContainText('Running');
});

test('refreshing a long activity preserves loaded pages and expanded tools', async ({
	page,
	context
}) => {
	await server(context);
	await page.goto(`/runs/${RUN.refactor}`);
	await page.getByRole('button', { name: 'Show more steps' }).click();
	const activity = page.locator('[data-run-activity]');
	await expect(activity.locator('li')).toHaveCount(162);
	const step = activity.locator('li').nth(149).getByRole('button');
	await step.click();
	await expect(step).toHaveAttribute('aria-expanded', 'true');
	const refreshed = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return url.pathname === `/api/runs/${RUN.refactor}` && url.searchParams.get('after') === '100';
	});
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await refreshed;
	await expect(activity.locator('li')).toHaveCount(162);
	await expect(step).toHaveAttribute('aria-expanded', 'true');
});
