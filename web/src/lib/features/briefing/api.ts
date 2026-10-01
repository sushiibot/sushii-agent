import type { BriefVote, Briefing } from './types';

export interface BriefingApi {
	/** Today's briefing, or null before the first one. */
	today(): Promise<Briefing | null>;
	/** A vote tunes what tomorrow leads with; null clears it. */
	vote(id: string, vote: BriefVote | null): Promise<void>;
	dismiss(id: string, dismissed: boolean): Promise<void>;
}
