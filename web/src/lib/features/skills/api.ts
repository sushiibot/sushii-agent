import { enc, featureHttp } from '$lib/core/feature-http';
import type { SkillDetail, SkillStage, SkillSummary } from './types';

export interface SkillsApi {
	list(): Promise<SkillSummary[]>;
	/** null: no such skill. */
	get(name: string): Promise<SkillDetail | null>;
	/** Moves a skill to `active` or `archived` by hand; the reason records it was you. */
	setStage(name: string, stage: Extract<SkillStage, 'active' | 'archived'>): Promise<SkillDetail>;
}

const http = featureHttp("Skills aren't available yet.");

export const httpSkillsApi: SkillsApi = {
	list: () => http.get('/skills'),
	get: (name) => http.find(`/skills/${enc(name)}`),
	setStage: (name, stage) => http.post(`/skills/${enc(name)}/stage`, { stage })
};
