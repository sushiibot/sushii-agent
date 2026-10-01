import { HttpError, request } from '$lib/core/http';
import { workspaceReadError } from '$lib/core/workspace-error';
import type { HistoryDayDetail, HistoryDaysPage, SearchResult } from './types';

export interface HistoryApi {
	days(q: { before?: string }): Promise<HistoryDaysPage>;
	day(date: string): Promise<HistoryDayDetail>;
	/** Chat and the agent's notes, merged. */
	search(query: string, signal?: AbortSignal): Promise<SearchResult>;
}

const UNSUPPORTED = "History isn't available yet.";

export const httpHistoryApi: HistoryApi = {
	async days({ before }) {
		const q = before ? `?before=${encodeURIComponent(before)}` : '';
		try {
			return await request<HistoryDaysPage>('GET', `/history/days${q}`);
		} catch (err) {
			throw workspaceReadError(err, UNSUPPORTED);
		}
	},
	async day(date) {
		try {
			return await request<HistoryDayDetail>('GET', `/history/days/${encodeURIComponent(date)}`);
		} catch (err) {
			// The bot answers 404 for a date that isn't on the calendar.
			if (err instanceof HttpError && err.status === 404) return { found: false };
			throw workspaceReadError(err, UNSUPPORTED);
		}
	},
	async search(query, signal) {
		// Notes being offline or busy is a 200 with `unavailable`; an error here is the bot's own.
		return request<SearchResult>('GET', `/search?q=${encodeURIComponent(query)}`, undefined, {
			signal
		});
	}
};
