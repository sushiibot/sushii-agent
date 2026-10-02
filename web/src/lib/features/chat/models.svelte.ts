import { HttpError, request } from '$lib/core/http';
import type { ModelsResponse, ModelsSearchResponse } from '$lib/core/realtime/events';
import { Remote } from '$lib/core/remote.svelte';
import { workspaceReadError } from '$lib/core/workspace-error';

export type { ModelsResponse, ModelsSearchResponse };
export type ModelRole = 'main' | 'fallback';

export interface ModelsApi {
	/** null: the agent is too old to say, so the composer shows no model. */
	get(conversationId?: string): Promise<ModelsResponse | null>;
	set(alias: string, role?: ModelRole): Promise<ModelsResponse>;
	/** Tool-capable OpenRouter models matching `query`, cheapest first. */
	search(query: string): Promise<ModelsSearchResponse>;
}

export const httpModelsApi: ModelsApi = {
	async get(conversationId) {
		try {
			return await request<ModelsResponse>(
				'GET',
				`/models${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`
			);
		} catch (err) {
			if (err instanceof HttpError && err.status === 501) return null;
			throw err;
		}
	},
	async set(alias, role = 'main') {
		try {
			return await request<ModelsResponse>('POST', '/models', {
				alias,
				...(role === 'fallback' ? { role } : {})
			});
		} catch (err) {
			if (err instanceof HttpError && err.status === 409) {
				throw new Error("The agent can't use that model. Pick another from the list.");
			}
			throw workspaceReadError(err, "This agent can't switch models from the app yet.");
		}
	},
	async search(query) {
		try {
			return await request<ModelsSearchResponse>(
				'GET',
				`/models/search?q=${encodeURIComponent(query)}`
			);
		} catch (err) {
			throw workspaceReadError(err, "This agent can't search models yet.");
		}
	}
};

const SEARCH_DEBOUNCE_MS = 250;

/** The owner's model choice, as `!model` reads and sets it; a switch applies from the next turn. */
export class ModelsStore {
	remote: Remote<ModelsResponse | null>;
	/** The alias being switched to. */
	picking = $state<string | null>(null);
	error = $state<string | null>(null);
	query = $state('');
	/** Matches for `query`; null before a search has answered. */
	results = $state.raw<ModelsSearchResponse['models'] | null>(null);
	searching = $state(false);
	searchError = $state<string | null>(null);

	#api: ModelsApi;
	#searchTimer: ReturnType<typeof setTimeout> | null = null;
	#searchRun = 0;

	constructor(api: ModelsApi, conversationId?: string) {
		this.#api = api;
		this.remote = new Remote(() => api.get(conversationId), { refetchOnFocus: true });
	}

	/** Reloads the choice, which `!model` or another device may have changed; clears an old error. */
	refresh() {
		this.error = null;
		void this.remote.refetch();
	}

	/** Searches OpenRouter as the owner types; an empty query clears the results. */
	setQuery(query: string) {
		this.query = query;
		if (this.#searchTimer) clearTimeout(this.#searchTimer);
		const run = ++this.#searchRun;
		if (!query.trim()) {
			this.results = null;
			this.searching = false;
			this.searchError = null;
			return;
		}
		this.searching = true;
		this.#searchTimer = setTimeout(async () => {
			try {
				const res = await this.#api.search(query.trim());
				if (run === this.#searchRun) this.results = res.models;
				if (run === this.#searchRun) this.searchError = null;
			} catch (err) {
				if (run === this.#searchRun) {
					this.searchError = err instanceof Error ? err.message : 'Something went wrong.';
				}
			} finally {
				if (run === this.#searchRun) this.searching = false;
			}
		}, SEARCH_DEBOUNCE_MS);
	}

	async pick(alias: string, role: ModelRole = 'main'): Promise<boolean> {
		if (this.picking) return false;
		this.picking = alias;
		this.error = null;
		try {
			const cost = this.remote.data?.cost;
			const choice = await this.#api.set(alias, role);
			this.remote.data = { ...choice, ...(cost ? { cost } : {}) };
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

export function modelsStore(conversationId?: string): ModelsStore {
	if (conversationId) return new ModelsStore(configured, conversationId);
	return (store ??= new ModelsStore(configured));
}

/** Serves a fixed list for dev mode and the e2e fixtures. */
export function createFixtureModelsApi(): ModelsApi {
	let current = 'sol';
	let fallback = 'openai/gpt-6-luna';
	const list = (): ModelsResponse => ({
		current,
		fallback,
		fallbackUntil: null,
		cost: {
			session: { usd: 0.042, recordedRuns: 3, unpricedRuns: 1 },
			today: { usd: 1.28, recordedRuns: 12, unpricedRuns: 2 },
			date: new Date().toISOString().slice(0, 10),
			timeZone: 'UTC'
		},
		models: [
			{ alias: 'sol', backend: 'chatgpt', id: 'gpt-6.1-sol', contextWindow: 1_050_000 },
			{ alias: 'luna', backend: 'chatgpt', id: 'gpt-6-luna', contextWindow: 1_050_000 },
			{
				alias: 'deepseek-pro',
				backend: 'openrouter',
				id: 'deepseek/deepseek-v4-pro',
				contextWindow: 1_048_576,
				priceIn: 0.21,
				priceOut: 0.42
			},
			{
				alias: 'luna-api',
				backend: 'openrouter',
				id: 'openai/gpt-6-luna',
				contextWindow: 1_050_000,
				priceIn: 0.1,
				priceOut: 0.5,
				image: true
			}
		]
	});
	return {
		get: async () => list(),
		set: async (alias, role) => {
			if (role === 'fallback') fallback = alias;
			else current = alias;
			return list();
		},
		search: async (query) => ({
			models: [
				{
					id: 'deepseek/deepseek-v4-flash',
					name: 'DeepSeek V4 Flash',
					priceIn: 0.04,
					priceOut: 0.08,
					contextWindow: 1_048_576
				},
				{
					id: 'qwen/qwen3.7-plus',
					name: 'Qwen3.7 Plus',
					priceIn: 0.32,
					priceOut: 1.28,
					contextWindow: 1_000_000
				}
			].filter(
				(m) =>
					m.id.includes(query.toLowerCase()) || m.name.toLowerCase().includes(query.toLowerCase())
			)
		})
	};
}
