import type { HistoryDayDetail, HistoryDaysPage, SearchResult } from './types';

export interface HistoryApi {
	days(q: { before?: string }): Promise<HistoryDaysPage>;
	day(date: string): Promise<HistoryDayDetail>;
	/** Chat and the agent's notes, merged. */
	search(query: string, signal?: AbortSignal): Promise<SearchResult>;
}
