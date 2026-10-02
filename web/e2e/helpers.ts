import { expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FixtureScenario } from '../src/lib/core/fixtures';
import { fakeBackend } from './fake-backend';
import { fixtureRoutes, type FixtureFeature, type FixtureRoutes } from './fixture-routes';

export async function smallTargets(page: Page) {
	return page.$$eval(
		'a, button, [role=button], [role=switch], [role=radio], input, textarea, summary',
		(els) =>
			els
				.filter((e) => !(e.tagName === 'A' && e.closest('p')))
				.map((e) => ({ e, r: e.getBoundingClientRect() }))
				.filter(({ r }) => r.width > 0 && (r.width < 48 || r.height < 48))
				.map(({ e }) => e.outerHTML.slice(0, 100))
	);
}

// Embla animates with requestAnimationFrame, outside the Web Animations API.
async function settlePagers(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect
		.poll(() =>
			page.evaluate(() =>
				Array.from(document.querySelectorAll<HTMLElement>('[data-tab-pager]')).every((viewport) => {
					const panel = viewport.querySelector<HTMLElement>(
						'[data-tab-panel][aria-hidden="false"]'
					);
					return (
						!panel ||
						Math.abs(panel.getBoundingClientRect().left - viewport.getBoundingClientRect().left) <
							0.5
					);
				})
			)
		)
		.toBe(true);
}

// The app shell scrolls inside <main>, so the document itself never grows: look at every element
// that sticks out of the viewport and every horizontal scroll container with something to scroll.
export async function horizontalOverflow(page: Page) {
	await settlePagers(page);
	return page.evaluate(() => {
		const width = document.documentElement.clientWidth;
		const describe = (el: Element) =>
			`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].slice(0, 4).join('.')}`;
		const offenders: string[] = [];
		const scroller = document.scrollingElement;
		if (scroller && scroller.scrollWidth > scroller.clientWidth) offenders.push('document scrolls');
		for (const el of document.body.querySelectorAll('*')) {
			// Pager tracks, inactive panels and scrollable tab labels intentionally sit inside clipped viewports.
			if (
				el.matches('[data-tab-track]') ||
				el.closest('[data-tab-panel][aria-hidden=true]') ||
				el.closest('[data-tab-strip]')
			)
				continue;
			const style = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			// Visually hidden text is clipped to 1px on purpose.
			if (r.width <= 1 && style.overflowX !== 'visible') continue;
			if (r.width > 0 && (r.right > width + 0.5 || r.left < -0.5)) {
				offenders.push(`${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)}`);
			}
			const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll';
			if (scrollsX && el.scrollWidth > el.clientWidth) {
				offenders.push(`${describe(el)} scrolls ${el.scrollWidth}/${el.clientWidth}`);
			}
		}
		return offenders;
	});
}

export async function axe(page: Page) {
	await settlePagers(page);
	// Scan the settled surface: fade-in opacity temporarily blends text with the scrim.
	// Infinite activity animations keep running and must never block accessibility checks.
	await page.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
				.map((animation) => animation.finished.catch(() => {}))
		);
	});
	const results = await new AxeBuilder({ page })
		.options({ rules: { 'target-size': { enabled: true } } })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();
	const ran = [
		...results.passes,
		...results.violations,
		...results.incomplete,
		...results.inapplicable
	];
	expect(ran.some((r) => r.id === 'target-size')).toBe(true);
	return results.violations.map(
		(v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
	);
}

type SseWindow = Window & {
	__sse: {
		hello: {
			headSeq: number;
			workspace: 'online' | 'offline';
			openTurns: unknown[];
			pending: { approvals: unknown[]; asks: unknown[] };
		};
		status: number;
		requests: string[];
		streams: ReadableStreamDefaultController<Uint8Array>[];
	};
};

/**
 * Replaces fetch for /api/chat/stream with an in-page stream the test writes frames into, since
 * route.fulfill can only answer with a finished body. Context-wide so it survives reloads.
 */
export async function stubStream(context: BrowserContext) {
	await context.addInitScript(() => {
		const w = window as unknown as SseWindow;
		w.__sse = {
			hello: {
				headSeq: 0,
				workspace: 'online',
				openTurns: [],
				pending: { approvals: [], asks: [] }
			},
			status: 200,
			requests: [],
			streams: []
		};
		const real = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
				location.href
			);
			if (url.pathname !== '/api/chat/stream') return real(input, init);
			w.__sse.requests.push(url.pathname + url.search);
			if (w.__sse.status !== 200) return new Response('no', { status: w.__sse.status });
			let ctrl!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
			w.__sse.streams.push(ctrl);
			init?.signal?.addEventListener('abort', () => {
				w.__sse.streams = w.__sse.streams.filter((c) => c !== ctrl);
				try {
					ctrl.error(new DOMException('aborted', 'AbortError'));
				} catch {
					// Already closed.
				}
			});
			ctrl.enqueue(
				new TextEncoder().encode(`event: hello\ndata: ${JSON.stringify(w.__sse.hello)}\n\n`)
			);
			return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
		};
	});
}

/** Writes one SSE frame to every open stream; a `seq` makes it a durable event. */
export async function push(page: Page, type: string, data: unknown, seq?: number) {
	await page.evaluate(
		({ type, data, seq }) => {
			const w = window as unknown as SseWindow;
			const id = seq === undefined ? '' : `id: ${seq}\n`;
			const frame = new TextEncoder().encode(
				`event: ${type}\n${id}data: ${JSON.stringify(data)}\n\n`
			);
			for (const c of w.__sse.streams) c.enqueue(frame);
		},
		{ type, data, seq }
	);
}

/** Ends every open stream, as the server does at its 15-minute lifetime. */
export async function endStreams(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as SseWindow;
		for (const c of w.__sse.streams.splice(0)) c.close();
	});
}

export const streamRequests = (page: Page) =>
	page.evaluate(() => (window as unknown as SseWindow).__sse.requests);

/**
 * The app with fixture previews enabled through the device override, the live routes from the shared
 * fake backend and the fixture screens' routes from their fixture APIs. `fixtures` picks the state
 * a fixture feature serves; the returned handle changes it mid-test.
 */
export async function fixtureApp(
	context: BrowserContext,
	opts: {
		fixtures?: Partial<Record<FixtureFeature, FixtureScenario>>;
		history?: unknown[];
		override?: string;
	} = {}
): Promise<FixtureRoutes> {
	await stubStream(context);
	await context.addInitScript((override) => {
		localStorage.setItem('features:override', override);
		localStorage.setItem('install-hint-dismissed', '1');
	}, opts.override ?? 'all');
	await context.route('**/api/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/chat/history')
			return route.fulfill({ json: { items: opts.history ?? [], before: null } });
		return route.fulfill({ status: 404, body: 'Not found' });
	});
	await fakeBackend(context);
	return fixtureRoutes(context, opts.fixtures);
}

/** axe, 48px targets and reflow at 412 and 320, in the page's current state. */
export async function checkScreen(page: Page) {
	expect(await axe(page)).toEqual([]);
	expect(await smallTargets(page)).toEqual([]);
	for (const width of [412, 320]) {
		await page.setViewportSize({ width, height: 800 });
		// Code scrolls inside its own box on purpose.
		const overflow = (await horizontalOverflow(page)).filter((o) => !o.startsWith('pre.'));
		expect(overflow, `overflow at ${width}px`).toEqual([]);
	}
	await page.setViewportSize({ width: 412, height: 915 });
}

/** Opens the phone drawer from the current screen's header and returns it. */
export async function openDrawer(page: Page) {
	await page.getByRole('button', { name: /^Menu/ }).click();
	const menu = page.getByRole('dialog', { name: 'Menu' });
	await expect(menu).toBeVisible();
	return menu;
}
