// Service-worker logic kept free of worker globals so the page, the worker and tests can share it.

export type PushPayload = {
	title?: unknown;
	body?: unknown;
	url?: unknown;
	tag?: unknown;
	silent?: unknown;
	requireInteraction?: unknown;
	renotify?: unknown;
};

export type PushMessage = { json(): unknown; text(): string };

export type NotificationSpec = {
	title: string;
	options: {
		body: string;
		tag?: string;
		icon: string;
		badge: string;
		silent?: boolean;
		requireInteraction?: boolean;
		renotify?: boolean;
		data: { url: string };
	};
};

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;
// Printable ASCII up to the bot's id cap.
const ASK_ID = /^[\x20-\x7e]{1,256}$/;
const HOME_ITEM =
	/^(?:job:[a-z0-9-]{1,64}|run:[0-9A-HJKMNP-TV-Z]{26}|approval:[A-Za-z0-9_-]{1,128}|(?:ask|turn):[\x20-\x7e]{1,256}|auth)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Route = {
	path: (p: string) => boolean;
	/** Allowed query keys and their check; a route takes at most one of them. */
	query?: Record<string, (v: string) => boolean>;
};
const at = (exact: string) => (p: string) => p === exact;

/** App routes a notification may open; anything else, including /api/ and /f/, opens Home. */
const ROUTES: Route[] = [
	{ path: at('/'), query: { approve: (v) => NONCE.test(v), ask: (v) => ASK_ID.test(v) } },
	{ path: at('/home'), query: { item: (v) => HOME_ITEM.test(v) } },
	{ path: at('/chat') },
	{ path: at('/more') },
	{ path: at('/settings') },
	{ path: at('/runs') },
	{ path: (p) => p.startsWith('/runs/') && RUN_ID.test(p.slice(6)) },
	{ path: at('/history') },
	{ path: (p) => p.startsWith('/history/') && realDate(p.slice(9)) },
	{ path: at('/history/search'), query: { q: (v) => v.length <= 200 } },
	// Screens on fixtures until their backends ship; one id segment at most, from a fixed charset.
	...['/chats', '/memory', '/memory/writes', '/skills', '/schedules', '/connectors'].map(
		(base): Route => ({ path: (p) => p === base || oneSegment(p, `${base}/`) })
	),
	{ path: (p) => oneSegment(p, '/memory/files/') },
	{ path: at('/briefing') },
	{ path: at('/browser') }
];

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const oneSegment = (p: string, prefix: string) =>
	p.startsWith(prefix) && SEGMENT.test(p.slice(prefix.length));

function realDate(s: string): boolean {
	if (!DATE.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** The same-origin app path for a notification's url, or '/' for anything else. */
export function safeTarget(raw: unknown, origin: string): string {
	if (typeof raw !== 'string' || !raw) return '/';
	let url: URL;
	try {
		url = new URL(raw, origin);
	} catch {
		return '/';
	}
	if (url.origin !== origin) return '/';
	const route = ROUTES.find((r) => r.path(url.pathname));
	if (!route) return '/';
	const keys = [...url.searchParams.keys()];
	if (keys.length > 1) return '/';
	for (const key of keys) {
		const check = route.query?.[key];
		const value = url.searchParams.get(key) ?? '';
		if (!check?.(value)) return '/';
	}
	const hash = /^#[a-z-]{1,32}$/.test(url.hash) ? url.hash : '';
	return url.pathname + url.search + hash;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4))
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	const raw = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

export function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
	if (!a || a.byteLength !== b.byteLength) return false;
	const view = new Uint8Array(a);
	return view.every((byte, i) => byte === b[i]);
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

export function notificationFor(
	message: PushMessage | null | undefined,
	origin: string
): NotificationSpec {
	let payload: PushPayload = {};
	if (message) {
		try {
			const parsed = message.json();
			if (parsed && typeof parsed === 'object') payload = parsed as PushPayload;
		} catch {
			payload = { body: message.text() };
		}
	}
	const tag = str(payload.tag) || undefined;
	const silent = bool(payload.silent);
	const requireInteraction = bool(payload.requireInteraction);
	// showNotification throws on renotify without a tag, and Chrome then shows its own generic notice.
	const renotify = tag ? bool(payload.renotify) : undefined;
	return {
		title: str(payload.title) || 'Agent',
		options: {
			body: str(payload.body) ?? '',
			tag,
			icon: '/icons/icon-192.png',
			badge: '/icons/badge-96.png',
			...(silent !== undefined ? { silent } : {}),
			...(requireInteraction !== undefined ? { requireInteraction } : {}),
			...(renotify !== undefined ? { renotify } : {}),
			data: { url: safeTarget(payload.url, origin) }
		}
	};
}

export interface WindowLike {
	url: string;
	focus(): Promise<unknown>;
	navigate(url: string): Promise<unknown>;
}

export async function openTarget(
	windows: readonly WindowLike[],
	target: string,
	openWindow: (url: string) => Promise<unknown>
): Promise<unknown> {
	const exact = windows.find((c) => c.url === target);
	if (exact) return exact.focus();
	const existing = windows[0];
	if (existing) {
		try {
			await existing.focus();
			// navigate() rejects for a window this worker doesn't control yet (first session).
			const navigated = await existing.navigate(target);
			if (navigated) return navigated;
		} catch {
			// Fall through to a fresh window at the target.
		}
	}
	return openWindow(target);
}

// A reverse proxy answers 502 while the bot restarts, so server errors get the shell too; a 4xx
// such as the owner check's 403 stays visible.
export async function navigationResponse(
	network: () => Promise<unknown>,
	cachedShell: () => Promise<Response | undefined>
): Promise<Response> {
	let res: unknown;
	try {
		res = await network();
	} catch {
		res = undefined;
	}
	// Offline fetch can resolve to something that isn't a Response.
	if (res instanceof Response && res.status < 500) return res;
	const shell = await cachedShell();
	if (shell) return shell;
	return res instanceof Response ? res : Response.error();
}

export interface SubscriptionLike {
	toJSON(): unknown;
}

export interface ResubscribeDeps {
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	subscribe: (options: {
		userVisibleOnly: boolean;
		applicationServerKey: Uint8Array<ArrayBuffer>;
	}) => Promise<SubscriptionLike>;
	newSubscription?: SubscriptionLike | null;
}

export async function resubscribe({
	fetch,
	subscribe,
	newSubscription
}: ResubscribeDeps): Promise<void> {
	let sub = newSubscription;
	if (!sub) {
		const res = await fetch('/api/push/key', { credentials: 'same-origin' });
		if (!res.ok) throw new Error(`push key request failed (${res.status})`);
		const { publicKey } = (await res.json()) as { publicKey: string };
		sub = await subscribe({
			userVisibleOnly: true,
			applicationServerKey: base64UrlToBytes(publicKey)
		});
	}
	const res = await fetch('/api/push/subscribe', {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(sub.toJSON())
	});
	if (!res.ok) throw new Error(`push subscribe request failed (${res.status})`);
}
