import { expect, test } from '@playwright/test';
import {
	base64UrlToBytes,
	navigationResponse,
	notificationFor,
	openTarget,
	resubscribe,
	sameKey,
	type WindowLike
} from '../src/lib/sw/handlers';

const PUBLIC_KEY =
	'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

const message = (raw: string) => ({ json: () => JSON.parse(raw), text: () => raw });

test.describe('push', () => {
	test('shows the payload fields', () => {
		expect(
			notificationFor(message('{"title":"Run failed","body":"b","url":"/runs/1","tag":"r1"}'))
		).toEqual({
			title: 'Run failed',
			options: {
				body: 'b',
				tag: 'r1',
				icon: '/icons/icon-192.png',
				badge: '/icons/badge-96.png',
				data: { url: '/runs/1' }
			}
		});
	});

	test('falls back to plain text and defaults', () => {
		const spec = notificationFor(message('not json'));
		expect(spec.title).toBe('Agent');
		expect(spec.options.body).toBe('not json');
		expect(spec.options.data.url).toBe('/');
	});

	test('still shows a notification without data', () => {
		expect(notificationFor(null).title).toBe('Agent');
		expect(notificationFor(message('null')).options.body).toBe('');
	});
});

test.describe('notification click', () => {
	const target = 'https://agent.test/runs/1';
	const win = (url: string, navigate: WindowLike['navigate'] = async () => ({ url })) => {
		const calls: string[] = [];
		const w: WindowLike = {
			url,
			focus: async () => calls.push('focus'),
			navigate: async (to) => {
				calls.push(`navigate ${to}`);
				return navigate(to);
			}
		};
		return { w, calls };
	};

	test('focuses a window already at the target', async () => {
		const other = win('https://agent.test/');
		const exact = win(target);
		const opened: string[] = [];
		await openTarget([other.w, exact.w], target, async (u) => opened.push(u));
		expect(exact.calls).toEqual(['focus']);
		expect(other.calls).toEqual([]);
		expect(opened).toEqual([]);
	});

	test('navigates an existing window', async () => {
		const existing = win('https://agent.test/');
		const opened: string[] = [];
		await openTarget([existing.w], target, async (u) => opened.push(u));
		expect(existing.calls).toEqual(['focus', `navigate ${target}`]);
		expect(opened).toEqual([]);
	});

	test('opens a new window when navigate rejects or there is none', async () => {
		const uncontrolled = win('https://agent.test/', async () => {
			throw new TypeError('not controlled');
		});
		const opened: string[] = [];
		await openTarget([uncontrolled.w], target, async (u) => opened.push(u));
		await openTarget([], target, async (u) => opened.push(u));
		expect(opened).toEqual([target, target]);
	});
});

test.describe('navigation fallback', () => {
	const shell = new Response('shell', { status: 200 });
	const cached = async () => shell;

	test('passes a healthy or 4xx response through', async () => {
		const ok = new Response('page');
		expect(await navigationResponse(async () => ok, cached)).toBe(ok);
		const forbidden = new Response('no', { status: 403 });
		expect(await navigationResponse(async () => forbidden, cached)).toBe(forbidden);
	});

	test('serves the shell on 5xx, network errors and non-responses', async () => {
		const bad = new Response('bad gateway', { status: 502 });
		expect(await navigationResponse(async () => bad, cached)).toBe(shell);
		expect(
			await navigationResponse(async () => Promise.reject(new TypeError('offline')), cached)
		).toBe(shell);
		expect(await navigationResponse(async () => undefined, cached)).toBe(shell);
	});

	test('keeps the server error when nothing is cached', async () => {
		const bad = new Response('bad gateway', { status: 502 });
		expect(
			await navigationResponse(
				async () => bad,
				async () => undefined
			)
		).toBe(bad);
		const failed = await navigationResponse(
			async () => Promise.reject(new TypeError('offline')),
			async () => undefined
		);
		expect(failed.type).toBe('error');
	});
});

test.describe('pushsubscriptionchange', () => {
	type Req = { url: string; init?: RequestInit };
	const server = (overrides: Record<string, Response> = {}) => {
		const requests: Req[] = [];
		const fetch = async (url: string, init?: RequestInit) => {
			requests.push({ url, init });
			if (overrides[url]) return overrides[url];
			if (url === '/api/push/key') return Response.json({ publicKey: PUBLIC_KEY });
			return Response.json({ ok: true });
		};
		return { requests, fetch };
	};
	const json = { endpoint: 'https://push.test/new', keys: { p256dh: 'p', auth: 'a' } };

	test('resubscribes with the server key and sends the new subscription', async () => {
		const { requests, fetch } = server();
		const options: unknown[] = [];
		await resubscribe({
			fetch,
			subscribe: async (o) => {
				options.push(o);
				return { toJSON: () => json };
			},
			newSubscription: null
		});
		expect(options).toEqual([
			{ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(PUBLIC_KEY) }
		]);
		expect(requests.map((r) => r.url)).toEqual(['/api/push/key', '/api/push/subscribe']);
		const post = requests[1].init!;
		expect(post.method).toBe('POST');
		expect(post.credentials).toBe('same-origin');
		expect(post.headers).toEqual({ 'content-type': 'application/json' });
		expect(JSON.parse(post.body as string)).toEqual(json);
	});

	test('sends a subscription the browser already renewed', async () => {
		const { requests, fetch } = server();
		await resubscribe({
			fetch,
			subscribe: async () => {
				throw new Error('should not subscribe');
			},
			newSubscription: { toJSON: () => json }
		});
		expect(requests.map((r) => r.url)).toEqual(['/api/push/subscribe']);
	});

	test('fails loudly when the server has no key or rejects the subscription', async () => {
		const noKey = server({ '/api/push/key': new Response('no', { status: 404 }) });
		await expect(
			resubscribe({ fetch: noKey.fetch, subscribe: async () => ({ toJSON: () => json }) })
		).rejects.toThrow('404');
		const broken = server({ '/api/push/subscribe': new Response('no', { status: 500 }) });
		await expect(
			resubscribe({ fetch: broken.fetch, subscribe: async () => ({ toJSON: () => json }) })
		).rejects.toThrow('500');
	});
});

test('decodes a VAPID key and compares keys', () => {
	const key = base64UrlToBytes(PUBLIC_KEY);
	expect(key.byteLength).toBe(65);
	expect(key[0]).toBe(4);
	expect(sameKey(key.slice().buffer, key)).toBe(true);
	expect(sameKey(new Uint8Array(65).buffer, key)).toBe(false);
	expect(sameKey(null, key)).toBe(false);
});
