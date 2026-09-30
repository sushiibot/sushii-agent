import { api, ApiError } from '$lib/api';

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

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4))
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	const raw = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
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

async function publicKey(): Promise<string> {
	try {
		return (await api.pushKey()).publicKey;
	} catch (err) {
		if (err instanceof ApiError && (err.status === 404 || err.status === 503)) {
			throw new PushSetupError('unavailable', "Notifications aren't set up on the server yet.");
		}
		throw err;
	}
}

export async function enablePush(): Promise<void> {
	if (!pushSupported()) {
		throw new PushSetupError('unsupported', "This browser can't receive notifications.");
	}
	const permission = await Notification.requestPermission();
	if (permission === 'denied') {
		throw new PushSetupError('blocked', 'Notifications are blocked for this app.');
	}
	if (permission !== 'granted') {
		throw new PushSetupError('off', 'Notifications stay off until you allow them.');
	}
	const key = await publicKey();
	const reg = await registration();
	let sub = await reg.pushManager.getSubscription();
	if (!sub) {
		sub = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: base64UrlToBytes(key)
		});
	}
	await api.subscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
	const reg = await registration();
	const sub = await reg.pushManager.getSubscription();
	if (!sub) return;
	await api.unsubscribe(sub.endpoint);
	await sub.unsubscribe();
}
