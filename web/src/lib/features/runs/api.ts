import type { RunDetail, RunsPage } from './types';

export interface RunsApi {
	/** Newest first; `before` is the previous page's cursor. */
	list(q: { before?: string }): Promise<RunsPage>;
	/** null: no run with that id. `after` pages the steps. */
	get(runId: string, q?: { after?: string }): Promise<RunDetail | null>;
}
