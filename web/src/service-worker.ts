/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';
import { navigationResponse, notificationFor, openTarget, resubscribe } from '$lib/sw/handlers';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `shell-${version}`;
// adapter-static writes the SPA fallback itself, so it is not listed in `build` or `files`.
const SHELL = '/';
const PRECACHE = [SHELL, ...build, ...files];

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
		// Fresh navigations are never written into this version's cache, so the fallback always
		// pairs the shell with its own assets.
		event.respondWith(
			navigationResponse(
				() => fetch(request),
				() => caches.match(SHELL)
			)
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
	const { title, options } = notificationFor(event.data);
	// Chrome shows its own generic notice if a push ends without a notification, so always show one.
	event.waitUntil(sw.registration.showNotification(title, options));
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url ?? '/', sw.location.origin).href;
	event.waitUntil(
		sw.clients
			.matchAll({ type: 'window', includeUncontrolled: true })
			.then((windows) => openTarget(windows, target, (url) => sw.clients.openWindow(url)))
	);
});

sw.addEventListener('pushsubscriptionchange', (event) => {
	event.waitUntil(
		resubscribe({
			fetch: (input, init) => fetch(input, init),
			subscribe: (options) => sw.registration.pushManager.subscribe(options),
			newSubscription: event.newSubscription
		}).catch((err) => console.warn('Could not renew the push subscription', err))
	);
});
