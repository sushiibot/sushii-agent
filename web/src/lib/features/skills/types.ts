// View models for Skills. Depends on the self-improving skills backend; this is what it will serve.
import type { DiffLine } from '$lib/ui/diff/diff-view.svelte';

export type SkillStage = 'draft' | 'active' | 'stale' | 'archived';

export interface SkillSummary {
	name: string;
	/** One line, from SKILL.md's frontmatter. */
	description: string;
	stage: SkillStage;
	/** Runs that loaded it. */
	uses: number;
	/** Of those, the share that ended verified, 0–1; null before any run. */
	successRate: number | null;
	lastUsed: string | null;
	version: number;
}

export interface SkillEvent {
	at: string;
	/** "Drafted", "Promoted to active", "Updated", "Marked stale", "Archived". */
	event: string;
	reason: string;
}

export interface SkillVersion {
	version: number;
	at: string;
	/** Why it changed, in one line. */
	reason: string;
	/** Against the version before; the first version is all additions. */
	diff: DiffLine[];
	/** The run that wrote it, if a run did. */
	run?: { id: string; title: string };
}

export interface SkillDetail extends SkillSummary {
	/** Why it is in its stage, in plain words. */
	why: string;
	history: SkillEvent[];
	runs: { id: string; title: string; ok: boolean; at: string }[];
	/** The current SKILL.md. Untrusted: render it only through Markdown. */
	content: string;
	/** Newest first. */
	versions: SkillVersion[];
}
