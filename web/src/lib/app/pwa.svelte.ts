import { dev } from '$app/environment';
import { resyncPush } from './push';

interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
	interface Window {
		__installPrompt?: BeforeInstallPromptEvent;
	}
}

class Pwa {
	online = $state(true);
	standalone = $state(false);
	installPrompt = $state<BeforeInstallPromptEvent | null>(null);
	waiting = $state<ServiceWorker | null>(null);
	swError = $state<string | null>(null);
	/** 'failed' when this device's push subscription couldn't be re-sent to the agent. */
	pushSync = $state<'pending' | 'ok' | 'failed'>('pending');
	#started = false;
	#reloadRequested = false;
	#syncing: Promise<void> | null = null;

	get canInstall() {
		return !this.standalone && this.installPrompt !== null;
	}

	start() {
		if (this.#started) return;
		this.#started = true;

		this.online = navigator.onLine;
		addEventListener('online', () => {
			this.online = true;
			this.#retryPushSync();
		});
		addEventListener('offline', () => (this.online = false));

		const standalone = matchMedia('(display-mode: standalone)');
		this.standalone = standalone.matches;
		standalone.addEventListener('change', (e) => (this.standalone = e.matches));

		// app.html captures an early prompt before this module loads.
		this.installPrompt = window.__installPrompt ?? null;
		addEventListener('beforeinstallprompt', (e) => {
			e.preventDefault();
			this.installPrompt = e as BeforeInstallPromptEvent;
		});
		addEventListener('appinstalled', () => (this.installPrompt = null));

		void this.#registerServiceWorker();
	}

	async install(): Promise<'accepted' | 'dismissed' | 'failed'> {
		const prompt = this.installPrompt;
		if (!prompt) return 'failed';
		// A prompt event can only be used once.
		this.installPrompt = null;
		try {
			await prompt.prompt();
			return (await prompt.userChoice).outcome;
		} catch {
			return 'failed';
		}
	}

	applyUpdate() {
		if (!this.waiting) return;
		// Another window may already have activated it, and then no controllerchange is coming.
		if (this.waiting.state === 'activated') {
			location.reload();
			return;
		}
		this.#reloadRequested = true;
		this.waiting.postMessage({ type: 'SKIP_WAITING' });
	}

	/** Re-sends the push subscription; concurrent callers share one attempt. */
	syncPush(): Promise<void> {
		this.#syncing ??= resyncPush()
			.then(() => {
				this.pushSync = 'ok';
			})
			.catch((err) => {
				this.pushSync = 'failed';
				console.warn('Could not re-send the push subscription', err);
			})
			.finally(() => {
				this.#syncing = null;
			});
		return this.#syncing;
	}

	/** Marks the subscription as in step after the user turned notifications on or off. */
	markPushSynced() {
		this.pushSync = 'ok';
	}

	#retryPushSync() {
		if (this.pushSync === 'failed') void this.syncPush();
	}

	async #registerServiceWorker() {
		if (!('serviceWorker' in navigator)) return;
		let reg: ServiceWorkerRegistration;
		try {
			reg = await navigator.serviceWorker.register('/service-worker.js', {
				type: dev ? 'module' : 'classic'
			});
		} catch (err) {
			this.swError = err instanceof Error ? err.message : String(err);
			return;
		}

		const track = (worker: ServiceWorker | null) => {
			if (!worker) return;
			const check = () => {
				if (worker.state === 'installed' && navigator.serviceWorker.controller) {
					this.waiting = worker;
				} else if (this.waiting === worker && worker.state === 'redundant') {
					this.waiting = null;
				}
			};
			check();
			worker.addEventListener('statechange', check);
		};
		track(reg.waiting);
		// A navigation can start an update before register() resolves.
		track(reg.installing);
		reg.addEventListener('updatefound', () => track(reg.installing));

		navigator.serviceWorker.addEventListener('controllerchange', () => {
			if (!this.#reloadRequested) return;
			this.#reloadRequested = false;
			location.reload();
		});

		// An installed app can stay open for days; look for a new build whenever it comes back.
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState !== 'visible') return;
			reg.update().catch(() => {});
			this.#retryPushSync();
		});

		void this.syncPush();
	}
}

export const pwa = new Pwa();
