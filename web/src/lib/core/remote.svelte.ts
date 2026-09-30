export type RemoteStatus = 'idle' | 'loading' | 'ready' | 'error';

const SLOW_MS = 300;

/**
 * One piece of server data with its loading state. Owned by a feature store rather than a
 * screen, so the data outlives the screen across tab switches.
 */
export class Remote<T> {
	status = $state<RemoteStatus>('idle');
	/** Loading has taken long enough that the screen should say so. */
	slow = $state(false);
	data = $state.raw<T | undefined>(undefined);
	error = $state<string | null>(null);

	#load: () => Promise<T>;
	#run = 0;
	#stopFocus: (() => void) | null = null;

	constructor(load: () => Promise<T>, opts: { refetchOnFocus?: boolean } = {}) {
		this.#load = load;
		if (opts.refetchOnFocus && typeof document !== 'undefined') {
			const onVisible = () => {
				if (document.visibilityState === 'visible' && this.status !== 'idle') void this.refetch();
			};
			document.addEventListener('visibilitychange', onVisible);
			this.#stopFocus = () => document.removeEventListener('visibilitychange', onVisible);
		}
	}

	/** Loads once; later calls reuse what is there. */
	ensure(): Promise<void> {
		return this.status === 'idle' ? this.refetch() : Promise.resolve();
	}

	async refetch(): Promise<void> {
		const run = ++this.#run;
		this.status = 'loading';
		this.error = null;
		this.slow = false;
		const slow = setTimeout(() => {
			if (run === this.#run) this.slow = true;
		}, SLOW_MS);
		try {
			const data = await this.#load();
			if (run !== this.#run) return;
			this.data = data;
			this.status = 'ready';
		} catch (err) {
			if (run !== this.#run) return;
			this.error = err instanceof Error ? err.message : 'Something went wrong. Try again.';
			this.status = 'error';
		} finally {
			clearTimeout(slow);
			if (run === this.#run) this.slow = false;
		}
	}

	destroy() {
		this.#stopFocus?.();
	}
}
