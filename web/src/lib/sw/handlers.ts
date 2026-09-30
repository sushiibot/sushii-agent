// Service-worker logic kept free of worker globals so the page, the worker and tests can share it.

export type PushPayload = { title?: string; body?: string; url?: string; tag?: string };

export type PushMessage = { json(): unknown; text(): string };

export type NotificationSpec = {
	title: string;
	options: {
		body: string;
		tag?: string;
		icon: string;
		badge: string;
		data: { url: string };
	};
};

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

export function notificationFor(message: PushMessage | null | undefined): NotificationSpec {
	let payload: PushPayload = {};
	if (message) {
		try {
			const parsed = message.json();
			if (parsed && typeof parsed === 'object') payload = parsed as PushPayload;
		} catch {
			payload = { body: message.text() };
		}
	}
	return {
		title: payload.title || 'Agent',
		options: {
			body: payload.body ?? '',
			tag: payload.tag,
			icon: '/icons/icon-192.png',
			badge: '/icons/badge-96.png',
			data: { url: payload.url || '/' }
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
