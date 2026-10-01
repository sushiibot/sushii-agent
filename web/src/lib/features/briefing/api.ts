import { enc, featureHttp } from '$lib/core/feature-http';
import type { BriefVote, Briefing } from './types';

export interface BriefingApi {
	/** Today's briefing, or null before the first one. */
	today(): Promise<Briefing | null>;
	/** A vote tunes what tomorrow leads with; null clears it. */
	vote(id: string, vote: BriefVote | null): Promise<void>;
	dismiss(id: string, dismissed: boolean): Promise<void>;
}

const http = featureHttp("The briefing isn't available yet.");

export const httpBriefingApi: BriefingApi = {
	today: () => http.get('/briefing'),
	vote: (id, vote) => http.act(`/briefing/items/${enc(id)}/vote`, { vote }),
	dismiss: (id, dismissed) => http.act(`/briefing/items/${enc(id)}/dismiss`, { dismissed })
};
