import { Remote } from '$lib/core/remote.svelte';
import { httpSkillsApi, type SkillsApi } from './api';
import type { SkillDetail, SkillSummary } from './types';

export class SkillsStore {
	list: Remote<SkillSummary[]>;
	busy = $state(false);
	error = $state<string | null>(null);

	#api: SkillsApi;
	#skills = new Map<string, Remote<SkillDetail | null>>();

	constructor(api: SkillsApi = httpSkillsApi) {
		this.#api = api;
		this.list = new Remote(() => api.list(), { refetchOnFocus: true });
	}

	skill(name: string) {
		let r = this.#skills.get(name);
		if (!r) this.#skills.set(name, (r = new Remote(() => this.#api.get(name))));
		return r;
	}

	async setStage(name: string, stage: 'active' | 'archived') {
		this.busy = true;
		this.error = null;
		try {
			this.skill(name).data = await this.#api.setStage(name, stage);
			void this.list.refetch();
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			this.busy = false;
		}
	}
}

let store: SkillsStore | null = null;
let configured: SkillsApi | undefined;

export function configureSkills(api: SkillsApi) {
	configured = api;
}

export function skillsStore(): SkillsStore {
	return (store ??= new SkillsStore(configured));
}
