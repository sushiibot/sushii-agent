import { HttpError, request, send } from '$lib/core/http';
import type { HomeResponse } from '$lib/core/realtime/events';
import type { HomeData } from './types';

/** Home's own server calls; approvals and asks are answered through chat's API. */
export interface HomeApi {
	/** null: the bot has Home turned off, so only the stream's part shows. */
	load(): Promise<HomeData | null>;
	/** Hides a failed job alert ("job:<name>") or failed run ("run:<runId>") from Home. */
	dismiss(id: string): Promise<void>;
	/** Takes a finished run ("run:<runId>") off "Ready for review" on every device. */
	opened(id: string): Promise<void>;
}

/** The parts of GET /api/home the stream doesn't already keep live. */
export function toHomeData(res: HomeResponse): HomeData {
	return {
		asOf: res.asOf,
		auth: res.waiting.auth,
		failed: res.failed,
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
	async opened(id) {
		await send('POST', '/home/opened', { id });
	}
};
