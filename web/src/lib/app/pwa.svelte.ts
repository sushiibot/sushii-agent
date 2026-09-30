import { dev } from '$app/environment';

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
	#started = false;
	#reloadRequested = false;

	get canInstall() {
		return !this.standalone && this.installPrompt !== null;
	}

	start() {
		if (this.#started) return;
		this.#started = true;

		this.online = navigator.onLine;
		addEventListener('online', () => (this.online = true));
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
		this.#reloadRequested = true;
		this.waiting.postMessage({ type: 'SKIP_WAITING' });
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
				}
			};
			check();
			worker.addEventListener('statechange', check);
		};
		track(reg.waiting);
		reg.addEventListener('updatefound', () => track(reg.installing));

		navigator.serviceWorker.addEventListener('controllerchange', () => {
			if (!this.#reloadRequested) return;
			this.#reloadRequested = false;
			location.reload();
		});

		// An installed app can stay open for days; look for a new build whenever it comes back.
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') reg.update().catch(() => {});
		});
	}
}

export const pwa = new Pwa();
