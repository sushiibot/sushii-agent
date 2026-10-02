// The bot's M2/M3 routes for the e2e suite, served from the feature fixtures over context.route.
// The app build never contains fixtures, so this is the only way the screens see them here.
import type { BrowserContext, Route } from '@playwright/test';
import type { HomeResponse, RunStatus, WebFeature } from '../src/lib/core/realtime/events';
import { historyDay, historyDays, searchFixtures } from '../src/lib/features/history/fixtures';
import { emptyHomeData, homeData } from '../src/lib/features/home/fixtures';
import { runDetailPage, runSummaries } from '../src/lib/features/runs/fixtures';

/**
 * What a route answers. `offline`, `unsupported`, `timeout` and `bad` are the bot's 503, 501, 504
 * and 502; `stale` is the 400 for an out-of-date cursor (older pages only).
 */
export type Scenario =
	| 'normal'
	| 'empty'
	| 'error'
	| 'slow'
	| 'offline'
	| 'unsupported'
	| 'timeout'
	| 'bad'
	| 'stale'
	| 'truncated';

export type Area = 'home' | 'runs' | 'history' | 'search';

export interface FakeBackend {
	set(area: Area, scenario: Scenario): void;
	/** A run's status from now on, in the list and its detail, as after a `run` event. */
	setRunStatus(runId: string, status: RunStatus): void;
	/** Every request to a route served here, in order. */
	calls: { method: string; path: string; search: string; body: unknown }[];
}

const ALL: WebFeature[] = ['runs', 'history', 'home', 'alerts'];
const PAGE = 10;
const SLOW_MS = 3000;

const json = (route: Route, data: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

/** The bot's answer for a workspace that can't answer, or null to answer normally. */
function failure(route: Route, scenario: Scenario) {
	switch (scenario) {
		case 'error':
			return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
		case 'offline':
			return json(route, { offline: true }, 503);
		case 'unsupported':
			return json(route, { unsupported: true }, 501);
		case 'timeout':
			return json(route, { timeout: true }, 504);
		case 'bad':
			return json(route, { bad_response: true }, 502);
		default:
			return null;
	}
}

/** `hidden`: dismissed or done item ids; `read`: opened ones. */
function homeResponse(scenario: Scenario, hidden: Set<string>, read: Set<string>): HomeResponse {
	const now = Date.now();
	const data = scenario === 'empty' ? emptyHomeData(now) : homeData(now);
	const shown = <T extends { runId: string }>(runs: T[]) =>
		runs.filter((r) => !hidden.has(`run:${r.runId}`));
	const workspace: HomeResponse['workspace'] =
		scenario === 'offline' || scenario === 'unsupported' || scenario === 'timeout'
			? { state: scenario }
			: scenario === 'bad'
				? { state: 'bad_response' }
				: data.workspace.state === 'online'
					? {
							...data.workspace,
							failedRuns: shown(data.workspace.failedRuns),
							review: shown(data.workspace.review).map((r) => ({
								...r,
								read: r.read || read.has(`run:${r.runId}`)
							}))
						}
					: data.workspace;
	return {
		asOf: data.asOf,
		waiting: { approvals: [], asks: [], auth: data.auth },
		openTurns: [],
		failed: data.failed.filter((a) => !hidden.has(a.id)),
		inbox: data.inbox
			.filter((m) => !hidden.has(`msg:${m.key}`))
			.map((m) => ({ ...m, read: m.read || read.has(`msg:${m.key}`) })),
		workspace
	};
}

/**
 * Registers the M2/M3 routes and GET /api/me (all features on unless `features` says otherwise).
 * Register it after the test's own catch-all route: anything else falls through to that.
 */
export async function fakeBackend(
	context: BrowserContext,
	opts: Partial<Record<Area, Scenario>> & { features?: WebFeature[]; now?: number } = {}
): Promise<FakeBackend> {
	const scenarios: Record<Area, Scenario> = {
		home: opts.home ?? 'normal',
		runs: opts.runs ?? 'normal',
		history: opts.history ?? 'normal',
		search: opts.search ?? 'normal'
	};
	const statuses = new Map<string, RunStatus>();
	const backend: FakeBackend = {
		set: (area, scenario) => void (scenarios[area] = scenario),
		setRunStatus: (runId, status) => void statuses.set(runId, status),
		calls: []
	};
	const withStatus = <T extends { runId: string; status: RunStatus }>(r: T): T => {
		const status = statuses.get(r.runId);
		return status ? { ...r, status } : r;
	};
	const features = opts.features ?? ALL;
	/** Dismissed and opened Home items, as the bot keeps them. */
	const hidden = new Set<string>();
	const read = new Set<string>();

	await context.route('**/api/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname;
		const area: Area | 'me' | null =
			path === '/api/me'
				? 'me'
				: path === '/api/home' || path.startsWith('/api/home/')
					? 'home'
					: path === '/api/runs' || path.startsWith('/api/runs/')
						? 'runs'
						: path.startsWith('/api/history/')
							? 'history'
							: path === '/api/search'
								? 'search'
								: null;
		if (!area) return route.fallback();
		const raw = req.postData();
		backend.calls.push({
			method: req.method(),
			path,
			search: url.search,
			body: raw ? JSON.parse(raw) : null
		});
		if (area === 'me') return json(route, { login: 'drk@example.com', features });
		const feature: WebFeature = area === 'search' ? 'history' : area;
		if (!features.includes(feature)) return json(route, { error: 'not found' }, 404);

		const scenario = scenarios[area];
		if (scenario === 'slow') await new Promise((r) => setTimeout(r, SLOW_MS));
		const now = opts.now ?? Date.now();

		if (area === 'home') {
			if (req.method() === 'POST') {
				const { id } = JSON.parse(raw ?? '{}') as { id: string };
				if (path === '/api/home/opened') read.add(id);
				else if (path === '/api/home/restore') hidden.delete(id);
				else hidden.add(id);
				return route.fulfill({ status: 204 });
			}
			if (scenario === 'error') return failure(route, scenario);
			return json(route, homeResponse(scenario, hidden, read));
		}

		if (area === 'search') {
			if (scenario === 'error') return failure(route, scenario);
			const q = (url.searchParams.get('q') ?? '').trim();
			const result = searchFixtures(now, q);
			if (scenario === 'empty') return json(route, { ...result, hits: [] });
			if (scenario === 'truncated') return json(route, { ...result, truncated: true });
			if (scenario === 'unsupported' || scenario === 'offline') {
				return json(route, {
					...result,
					hits: result.hits.filter((h) => h.source === 'chat'),
					unavailable: ['notes']
				});
			}
			return json(route, result);
		}

		const failed = failure(route, scenario);
		if (failed) return failed;

		if (area === 'runs') {
			const detail = /^\/api\/runs\/([^/]+)$/.exec(path);
			if (detail) {
				const page = runDetailPage(now, detail[1]!, url.searchParams.get('after') ?? undefined);
				return page
					? json(route, { ...page, run: withStatus(page.run) })
					: json(route, { error: 'not found' }, 404);
			}
			const before = url.searchParams.get('before');
			if (before && scenario === 'stale') return json(route, { error: 'invalid cursor' }, 400);
			if (scenario === 'empty') return json(route, { runs: [], before: null, truncated: false });
			const kinds = url.searchParams.get('kind')?.split(',');
			const all = runSummaries(now)
				.map(withStatus)
				.filter((r) => !kinds || kinds.includes(r.kind));
			const start = before ? all.findIndex((r) => r.runId === before) + 1 : 0;
			const runs = all.slice(start, start + PAGE);
			const more = start + PAGE < all.length;
			return json(route, {
				runs,
				before: more ? runs.at(-1)!.runId : null,
				truncated: !more && !!before
			});
		}

		const day = /^\/api\/history\/days\/([^/]+)$/.exec(path);
		if (day) return json(route, historyDay(now, day[1]!));
		if (path !== '/api/history/days') return json(route, { error: 'not found' }, 404);
		const before = url.searchParams.get('before');
		if (before && scenario === 'stale') return json(route, { error: 'invalid cursor' }, 400);
		if (scenario === 'empty') return json(route, { days: [], before: null });
		const all = historyDays(now);
		const start = before ? all.findIndex((d) => d.date === before) + 1 : 0;
		const days = all.slice(start, start + PAGE);
		return json(route, { days, before: start + PAGE < all.length ? days.at(-1)!.date : null });
	});
	return backend;
}
