import { expect, test, type BrowserContext } from '@playwright/test';
import { fixtureApp, push } from './helpers';
import type { RunDetailResponse, RunSummary } from '../src/lib/core/realtime/events';
test.beforeEach(async ({ page }) => {
	page.on('pageerror', (error) =>
		console.error('BACKGROUND PAGE ERROR:', error.stack ?? error.message)
	);
	page.on('requestfailed', (request) =>
		console.error('BACKGROUND REQUEST FAILED:', request.url(), request.failure()?.errorText)
	);
});
const MAIN = '01K6B2N8W3J5Q7R9T1V3X5Z7A9';
const TRIP = '01K6B2N8W3J5Q7R9T1V3X5Z7AA';
const TURN = 'parent-turn';
const at = new Date().toISOString();
const reply = {
	type: 'assistant',
	id: 'parent-reply',
	turnId: TURN,
	at,
	text: 'I started the code changes.',
	tools: [],
	files: []
};
async function agents(
	context: BrowserContext,
	history: unknown[] = [reply],
	mainOutsideRecent = false
) {
	await fixtureApp(context, { history });
	const listCalls: string[] = [],
		stops: string[] = [];
	const runs: RunSummary[] = [
		{
			runId: MAIN,
			conversationId: 'main',
			turnId: TURN,
			kind: 'subagent',
			agentName: 'coder',
			repo: 'sushiibot-sushii-agent',
			title: 'Implement thread UX changes',
			status: 'running',
			startedAt: at
		},
		{
			runId: TRIP,
			conversationId: 'oct-trip',
			turnId: 'trip-parent',
			kind: 'subagent',
			agentName: 'researcher',
			title: 'Check train options',
			status: 'running',
			startedAt: at
		}
	];
	await context.route('**/api/runs**', async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === '/api/runs') {
			const conversation = url.searchParams.get('conversationId') ?? '';
			listCalls.push(conversation);
			return route.fulfill({
				json: {
					runs: runs.filter(
						(r) =>
							r.conversationId === conversation &&
							(url.searchParams.get('status') !== 'running' || r.status === 'running') &&
							(!mainOutsideRecent ||
								url.searchParams.get('status') === 'running' ||
								r.runId !== MAIN)
					),
					before: null,
					truncated: false
				}
			});
		}
		const run = runs.find((r) => r.runId === url.pathname.split('/')[3]);
		if (!run) return route.fulfill({ status: 404 });
		if (url.pathname.endsWith('/stop')) {
			expect(route.request().method()).toBe('POST');
			stops.push(run.runId);
			run.status = 'aborted';
			run.endedAt = new Date().toISOString();
			return route.fulfill({ json: { stopped: true } });
		}
		const detail: RunDetailResponse = {
			run,
			children: [],
			session: 'ok',
			steps: [
				{
					id: 'step1',
					type: 'assistant',
					at,
					text: run.runId === MAIN ? 'Reading thread routes.' : 'Checking rail schedules.'
				}
			],
			after: null,
			approvals: [],
			files: []
		};
		return route.fulfill({ json: detail });
	});
	return { runs, listCalls, stops };
}
test('delegated work stays on its originating turn after the parent finishes and survives reload', async ({
	page,
	context
}) => {
	await agents(context, []);
	await page.goto('/chat');
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await push(page, 'snapshot', {
		turnId: TURN,
		view: { turnId: TURN, startedAt: Date.now(), lines: [], toolCount: 0, text: reply.text }
	});
	const card = page.locator('[data-delegated-agents]');
	await expect(card).toContainText('Implement thread UX changes');
	await expect(card).toContainText('coder · sushiibot-sushii-agent · Running');
	await expect(card).toContainText('Reading thread routes.');
	await expect(
		page
			.locator('[data-message-id]')
			.filter({ hasText: reply.text })
			.locator('[data-delegated-agents]')
	).toHaveCount(1);
	await push(page, 'reply', { key: 'parent-reply', turnId: TURN, text: reply.text, files: [] }, 1);
	await push(page, 'turn_final', { turnId: TURN, outcome: 'done', summary: null }, 2);
	await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
	await expect(card).toBeVisible();
	await expect(page.locator('[data-background-work]')).toContainText('Background work · 1 running');
	await context.route('**/api/chat/history**', (route) =>
		route.fulfill({ json: { items: [reply], before: null } })
	);
	await page.reload();
	await expect(page.locator('[data-delegated-agents]')).toContainText(
		'Implement thread UX changes'
	);
	await expect(page.locator('[data-background-work]')).toContainText('1 running');
	await page.screenshot({ path: '/tmp/background-mobile.png' });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: '/tmp/background-desktop.png' });
});
test('task activity opens in a sheet, back closes it, and Stop targets only that agent', async ({
	page,
	context
}) => {
	const backend = await agents(context);
	await page.goto('/chat');
	const card = page.locator('[data-delegated-agents]').getByRole('button');
	await card.click();
	const sheet = page.getByRole('dialog', { name: 'Agent activity' });
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText('Reading thread routes.');
	await page.screenshot({ path: '/tmp/background-sheet-mobile.png' });
	await expect(sheet.getByRole('link', { name: 'Full run details' })).toHaveAttribute(
		'href',
		`/runs/${MAIN}`
	);
	await page.goBack();
	await expect(sheet).toBeHidden();
	await expect(page).toHaveURL(/\/chat$/);
	await expect(card).toBeVisible();
	await card.click();
	await sheet.getByRole('link', { name: 'Full run details' }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${MAIN}$`));
	await page.goBack();
	await expect(page).toHaveURL(/\/chat$/);
	await expect(sheet).toBeHidden();
	await expect(card).toBeVisible();
	await card.click();
	await sheet.getByRole('button', { name: 'Stop agent' }).click();
	await expect.poll(() => backend.stops).toEqual([MAIN]);
	await expect(sheet).toContainText('aborted');
	await expect(sheet.getByRole('button', { name: 'Stop agent' })).toBeHidden();
	await expect(page.locator('[data-background-work]')).toBeHidden();
	expect(backend.runs.find((r) => r.runId === TRIP)?.status).toBe('running');
});
test('Main and topic conversations show only their own background work', async ({
	page,
	context
}) => {
	const backend = await agents(context);
	await page.goto('/chat');
	await expect(page.locator('[data-background-work]')).toContainText('1 running');
	await expect(page.locator('[data-delegated-agents]')).not.toContainText('Check train options');
	await page.goto('/chats/oct-trip');
	await expect(page.getByRole('heading', { name: 'October trip', level: 1 })).toBeVisible();
	const strip = page.locator('[data-background-work]');
	await expect(strip).toContainText('1 running');
	await strip.locator('summary').click();
	await expect(strip).toContainText('Check train options');
	await expect(strip).not.toContainText('Implement thread UX changes');
	await strip.getByRole('button', { name: 'Check train options' }).click();
	await expect(page.getByRole('dialog', { name: 'Agent activity' })).toContainText(
		'Checking rail schedules.'
	);
	expect(backend.listCalls).toContain('main');
	expect(backend.listCalls).toContain('oct-trip');
	expect(backend.listCalls).not.toContain('');
});

test('an active agent remains visible when newer finished runs push it beyond the recent page', async ({
	page,
	context
}) => {
	await agents(context, [reply], true);
	await page.goto('/chat');
	await expect(page.locator('[data-delegated-agents]')).toContainText(
		'Implement thread UX changes'
	);
	await expect(page.locator('[data-background-work]')).toContainText('1 running');
});

test('cards and the activity sheet follow later pages and retain the latest activity after an empty poll', async ({
	page,
	context
}) => {
	await agents(context);
	const cursors: (string | null)[] = [];
	await context.route(`**/api/runs/${MAIN}**`, (route) => {
		const after = new URL(route.request().url()).searchParams.get('after');
		cursors.push(after);
		const steps = !after
			? Array.from({ length: 100 }, (_, i) => ({
					id: `step${i + 1}`,
					type: 'assistant',
					at,
					text: `Earlier activity ${i + 1}`
				}))
			: after === 'step100'
				? [{ id: 'step101', type: 'assistant', at, text: 'Later activity beyond the first page.' }]
				: [];
		return route.fulfill({
			json: {
				run: {
					runId: MAIN,
					conversationId: 'main',
					turnId: TURN,
					kind: 'subagent',
					agentName: 'coder',
					title: 'Implement thread UX changes',
					status: 'running',
					startedAt: at
				},
				steps,
				after: !after ? 'step100' : null,
				children: [],
				session: 'ok',
				approvals: [],
				files: []
			}
		});
	});
	await page.goto('/chat');
	const card = page.locator('[data-delegated-agents]');
	await expect(card).toContainText('Later activity beyond the first page.');
	await card.getByRole('button').click();
	const sheet = page.getByRole('dialog', { name: 'Agent activity' });
	await expect(sheet).toContainText('Later activity beyond the first page.');
	await expect(sheet.getByRole('link', { name: 'Full run details' })).toHaveAttribute(
		'href',
		`/runs/${MAIN}`
	);
	await expect.poll(() => cursors.includes('step101')).toBe(true);
	await expect(card).toContainText('Later activity beyond the first page.');
	expect(cursors.filter((cursor) => cursor === null)).toHaveLength(1);
});
