/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `shell-${version}`;
// adapter-static writes the SPA fallback itself, so it is not listed in `build` or `files`.
const SHELL = '/';
const PRECACHE = [SHELL, ...build, ...files];

type PushPayload = { title?: string; body?: string; url?: string; tag?: string };

sw.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
	);
});

sw.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') void sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== sw.location.origin || url.pathname.startsWith('/api/')) return;

	if (request.mode === 'navigate') {
		// Network-first; the cached shell only stands in when the network is gone. Fresh navigations
		// are never written into this version's cache, so offline always pairs the shell with its own assets.
		event.respondWith(
			fetch(request).catch(async () => (await caches.match(SHELL)) ?? Response.error())
		);
		return;
	}

	if (PRECACHE.includes(url.pathname)) {
		event.respondWith(
			caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) ?? fetch(request))
		);
	}
});

sw.addEventListener('push', (event) => {
	let payload: PushPayload = {};
	try {
		payload = event.data?.json() ?? {};
	} catch {
		payload = { body: event.data?.text() };
	}
	// Chrome shows its own generic notice if a push ends without a notification, so always show one.
	event.waitUntil(
		sw.registration.showNotification(payload.title || 'Agent', {
			body: payload.body ?? '',
			tag: payload.tag,
			icon: '/icons/icon-192.png',
			badge: '/icons/badge-96.png',
			data: { url: payload.url || '/' }
		})
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url ?? '/', sw.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const exact = windows.find((c) => c.url === target);
			if (exact) return exact.focus();
			const existing = windows[0];
			if (existing) {
				try {
					// navigate() rejects for a window this worker doesn't control yet (first session).
					await existing.focus();
					const navigated = await existing.navigate(target);
					if (navigated) return navigated;
				} catch {
					// Fall through to a fresh window at the target.
				}
			}
			return sw.clients.openWindow(target);
		})()
	);
});
