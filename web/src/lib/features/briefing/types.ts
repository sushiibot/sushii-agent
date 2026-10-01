// View models for the morning briefing. Needs P1's connectors; this is what the bot will serve.

export type BriefVote = 'up' | 'down';

export interface BriefItem {
	id: string;
	section: 'top' | 'ahead';
	/** Agent-written, plain text. */
	title: string;
	detail: string;
	/** Where it came from. `href` is an in-app link (a run, a day in History) when there is one. */
	source: { label: string; href?: string };
	vote?: BriefVote;
	dismissed?: boolean;
}

export interface Briefing {
	/** The calendar day it is for, YYYY-MM-DD. */
	date: string;
	/** When it was written. */
	at: string;
	items: BriefItem[];
}
