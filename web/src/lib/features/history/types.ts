// The history shapes M23-ARCH pins (historyDaysResult, historyDayResult, searchHit), mirrored here
// until they land in the wire copy of events.ts. Chat hits and the merged result are not pinned yet.
import type { RunSummary } from '$lib/features/runs';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const QUERY_MIN = 2;
export const QUERY_MAX = 200;

export interface HistoryDay {
	date: string;
	runs: number;
	sessions: number;
}

export interface HistoryDaysPage {
	days: HistoryDay[];
	/** Cursor for older days; null when there are none. */
	before: string | null;
}

export type HistoryDayDetail =
	| { found: false }
	| {
			found: true;
			date: string;
			/** The day's `## Sessions` recaps, as the agent wrote them. */
			sessions: { heading: string; markdown: string }[];
			/** Runs that started that local day. */
			runs: RunSummary[];
			/** The day's file was larger than the read cap. */
			truncated: boolean;
	  };

/** [start, end) in code points of `snippet`. */
export type Range = [number, number];

/** A match in the agent's notes under ~/history (`searchHit`). */
export interface NotesHit {
	source: 'notes';
	/** "<relPath>:<line>" */
	id: string;
	kind: 'daily' | 'run';
	date: string;
	runId?: string;
	line: number;
	/** The nearest heading above the match. */
	heading?: string;
	snippet: string;
	ranges: Range[];
}

/** A match in the chat the bot stores. */
export interface ChatHit {
	source: 'chat';
	id: string;
	at: string;
	role: 'user' | 'agent';
	snippet: string;
	ranges: Range[];
}

export type SearchHit = NotesHit | ChatHit;

/** Both sources merged, newest first. */
export interface SearchResult {
	query: string;
	hits: SearchHit[];
	/** A source stopped early (time, size or count cap), so matches may be missing. */
	truncated: boolean;
	/** Sources that could not be searched this time. */
	unavailable: ('chat' | 'notes')[];
}
