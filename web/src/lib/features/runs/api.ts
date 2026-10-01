import { HttpError, request } from '$lib/core/http';
import { workspaceReadError } from '$lib/core/workspace-error';
import type { RunDetail, RunsPage } from './types';

export interface RunsApi {
	/** Newest first; `before` is the previous page's cursor. */
	list(q: { before?: string }): Promise<RunsPage>;
	/** null: no run with that id. `after` pages the steps. */
	get(runId: string, q?: { after?: string }): Promise<RunDetail | null>;
}

const UNSUPPORTED = "Runs aren't available yet.";

function query(params: Record<string, string | undefined>): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
	const s = q.toString();
	return s ? `?${s}` : '';
}

export const httpRunsApi: RunsApi = {
	async list({ before }) {
		try {
			return await request<RunsPage>('GET', `/runs${query({ before })}`);
		} catch (err) {
			throw workspaceReadError(err, UNSUPPORTED);
		}
	},
	async get(runId, q = {}) {
		try {
			return await request<RunDetail>(
				'GET',
				`/runs/${encodeURIComponent(runId)}${query({ after: q.after })}`
			);
		} catch (err) {
			if (err instanceof HttpError && err.status === 404) return null;
			throw workspaceReadError(err, UNSUPPORTED);
		}
	}
};
