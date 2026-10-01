import type { SkillDetail, SkillStage, SkillSummary } from './types';

export interface SkillsApi {
	list(): Promise<SkillSummary[]>;
	/** null: no such skill. */
	get(name: string): Promise<SkillDetail | null>;
	/** Moves a skill to `active` or `archived` by hand; the reason records it was you. */
	setStage(name: string, stage: Extract<SkillStage, 'active' | 'archived'>): Promise<SkillDetail>;
}
