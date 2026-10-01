import { HttpError, request } from '$lib/core/http';
import type { ModelsResponse } from '$lib/core/realtime/events';
import { Remote } from '$lib/core/remote.svelte';
import { workspaceReadError } from '$lib/core/workspace-error';

export type { ModelsResponse };

export interface ModelsApi {
	/** null: the agent is too old to say, so the composer shows no model. */
	get(): Promise<ModelsResponse | null>;
	set(alias: string): Promise<ModelsResponse>;
}

export const httpModelsApi: ModelsApi = {
	async get() {
		try {
			return await request<ModelsResponse>('GET', '/models');
		} catch (err) {
			if (err instanceof HttpError && err.status === 501) return null;
			throw err;
		}
	},
	async set(alias) {
		try {
			return await request<ModelsResponse>('POST', '/models', { alias });
		} catch (err) {
			if (err instanceof HttpError && err.status === 409) {
				throw new Error('That model is no longer on the list. Pick from the updated one.');
			}
			throw workspaceReadError(err, "This agent can't switch models from the app yet.");
		}
	}
};

/** The owner's model choice, as `!model` reads and sets it; a switch applies from the next turn. */
export class ModelsStore {
	remote: Remote<ModelsResponse | null>;
	/** The alias being switched to. */
	picking = $state<string | null>(null);
	error = $state<string | null>(null);

	#api: ModelsApi;

	constructor(api: ModelsApi) {
		this.#api = api;
		this.remote = new Remote(() => api.get(), { refetchOnFocus: true });
	}

	/** Reloads the choice, which `!model` or another device may have changed; clears an old error. */
	refresh() {
		this.error = null;
		void this.remote.refetch();
	}

	async pick(alias: string): Promise<boolean> {
		if (this.picking) return false;
		this.picking = alias;
		this.error = null;
		try {
			this.remote.data = await this.#api.set(alias);
			return true;
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Something went wrong.';
			return false;
		} finally {
			this.picking = null;
			// Supersedes a load that started before the switch, and after a failure or timeout shows
			// what the workspace actually has.
			void this.remote.refetch();
		}
	}
}

let store: ModelsStore | null = null;
let configured: ModelsApi = httpModelsApi;

/** Swaps in another API, for tests and dev mode; call before the first store. */
export function configureModels(api: ModelsApi) {
	configured = api;
}

export function modelsStore(): ModelsStore {
	return (store ??= new ModelsStore(configured));
}

/** Serves a fixed list for dev mode and the e2e fixtures. */
export function createFixtureModelsApi(): ModelsApi {
	let current = 'sol';
	const list = (): ModelsResponse => ({
		current,
		models: [
			{ alias: 'sol', backend: 'chatgpt', id: 'gpt-6.1-sol' },
			{ alias: 'luna', backend: 'chatgpt', id: 'gpt-6-luna' },
			{ alias: 'or-luna', backend: 'openrouter', id: 'openai/gpt-6-luna' }
		]
	});
	return {
		get: async () => list(),
		set: async (alias) => {
			current = alias;
			return list();
		}
	};
}
