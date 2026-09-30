import { api, ApiError } from '$lib/api';
import { base64UrlToBytes, sameKey } from '$lib/sw/handlers';

export type PushStatus = 'unsupported' | 'blocked' | 'unavailable' | 'off' | 'on';

export class PushSetupError extends Error {
	constructor(
		readonly status: PushStatus,
		message: string
	) {
		super(message);
		this.name = 'PushSetupError';
	}
}

export function pushSupported(): boolean {
	return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
	const reg = await Promise.race([
		navigator.serviceWorker.ready,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
	]);
	if (!reg) {
		throw new PushSetupError(
			'unavailable',
			"The app's background worker isn't running yet. Reload the app and try again."
		);
	}
	return reg;
}

export async function currentPushStatus(): Promise<PushStatus> {
	if (!pushSupported()) return 'unsupported';
	if (Notification.permission === 'denied') return 'blocked';
	// getRegistration() answers at once, while `ready` waits for the first install to finish.
	const reg = await navigator.serviceWorker.getRegistration();
	const sub = await reg?.pushManager.getSubscription();
	return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Calls `onChange` whenever the notification permission may have changed; returns a cleanup. */
export function watchPermission(onChange: () => void): () => void {
	const onVisible = () => {
		if (document.visibilityState === 'visible') onChange();
	};
	document.addEventListener('visibilitychange', onVisible);
	addEventListener('focus', onChange);
	let status: PermissionStatus | null = null;
	let stopped = false;
	navigator.permissions
		?.query({ name: 'notifications' })
		.then((s) => {
			if (stopped) return;
			status = s;
			status.addEventListener('change', onChange);
		})
		.catch(() => {
			// No change events here; visibility and focus still cover a trip to Android settings.
		});
	return () => {
		stopped = true;
		document.removeEventListener('visibilitychange', onVisible);
		removeEventListener('focus', onChange);
		status?.removeEventListener('change', onChange);
	};
}

async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
	try {
		return base64UrlToBytes((await api.pushKey()).publicKey);
	} catch (err) {
		if (err instanceof ApiError && (err.status === 404 || err.status === 503)) {
			throw new PushSetupError('unavailable', "Notifications aren't set up on the server yet.");
		}
		throw err;
	}
}

// A subscription made with an older server key can't receive anything, so it is replaced.
async function subscriptionFor(
	reg: ServiceWorkerRegistration,
	key: Uint8Array<ArrayBuffer>
): Promise<PushSubscription> {
	const existing = await reg.pushManager.getSubscription();
	if (existing && sameKey(existing.options.applicationServerKey, key)) return existing;
	if (existing) {
		await api.unsubscribe(existing.endpoint).catch(() => {});
		await existing.unsubscribe().catch(() => {});
	}
	return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

export async function enablePush(): Promise<void> {
	if (!pushSupported()) {
		throw new PushSetupError('unsupported', "This browser can't receive notifications.");
	}
	// Asking for the key first means nobody grants OS permission for a server that can't push.
	const key = await serverKey();
	const permission = await Notification.requestPermission();
	if (permission === 'denied') {
		throw new PushSetupError('blocked', 'Notifications are blocked for this app.');
	}
	if (permission !== 'granted') {
		throw new PushSetupError('off', 'Notifications stay off until you allow them.');
	}
	const reg = await registration();
	const sub = await subscriptionFor(reg, key);
	try {
		await api.subscribe(sub.toJSON());
	} catch (err) {
		// Keep the browser and the server in agreement: no server row means no browser subscription.
		await sub.unsubscribe().catch(() => {});
		throw err;
	}
}

/**
 * Re-sends this device's subscription; the server upserts by endpoint, so this heals a lost row.
 * Resolves false when there is nothing to send.
 */
export async function resyncPush(): Promise<boolean> {
	if (!pushSupported() || Notification.permission !== 'granted') return false;
	const reg = await navigator.serviceWorker.getRegistration();
	if (!reg || !(await reg.pushManager.getSubscription())) return false;
	const sub = await subscriptionFor(reg, await serverKey());
	await api.subscribe(sub.toJSON());
	return true;
}

export async function disablePush(): Promise<void> {
	const reg = await registration();
	const sub = await reg.pushManager.getSubscription();
	if (!sub) return;
	await api.unsubscribe(sub.endpoint);
	await sub.unsubscribe();
}
