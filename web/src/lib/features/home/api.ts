import { HttpError, request, send } from '$lib/core/http';
import type { HomeResponse } from '$lib/core/realtime/events';
import type { HomeData } from './types';

/** Home's own server calls; approvals and asks are answered through chat's API. */
export interface HomeApi {
	/** null: the bot has Home turned off, so only the stream's part shows. */
	load(): Promise<HomeData | null>;
	/** Hides a failed job alert ("job:<name>"), or marks a run ("run:<runId>") or message ("msg:<key>") done. */
	dismiss(id: string): Promise<void>;
	/** Undoes marking a run or message done. */
	restore(id: string): Promise<void>;
	/** Marks an inbox run or message read on every device. */
	opened(id: string): Promise<void>;
}

/** The parts of GET /api/home the stream doesn't already keep live. */
export function toHomeData(res: HomeResponse): HomeData {
	return {
		asOf: res.asOf,
		auth: res.waiting.auth,
		failed: res.failed,
		inbox: res.inbox,
		workspace: res.workspace
	};
}

export const httpHomeApi: HomeApi = {
	async load() {
		try {
			return toHomeData(await request<HomeResponse>('GET', '/home'));
		} catch (err) {
			if (err instanceof HttpError && err.status === 404) return null;
			throw err;
		}
	},
	async dismiss(id) {
		try {
			await send('POST', '/home/dismiss', { id });
		} catch (err) {
			// Already gone on the server (recovered, or dismissed elsewhere): what was asked for.
			if (err instanceof HttpError && err.status === 404) return;
			throw err;
		}
	},
	async restore(id) {
		await send('POST', '/home/restore', { id });
	},
	async opened(id) {
		await send('POST', '/home/opened', { id });
	}
};
