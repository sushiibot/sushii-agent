import type { RunDetail, RunStep } from './types';

const PAGES_PER_POLL = 3;
const RECENT_STEPS = 100;
type Entry = {
	detail?: RunDetail;
	cursor?: string;
	beforeFirst?: string;
	pending?: Promise<RunDetail>;
};

/** Incremental activity shared by conversation cards and their sheet; full history stays on the run page. */
export class RunActivityCache {
	#runs = new Map<string, Entry>();
	constructor(private readonly fetchPage: (runId: string, after?: string) => Promise<RunDetail>) {}
	read(runId: string): Promise<RunDetail> {
		const entry = this.#runs.get(runId) ?? {};
		this.#runs.set(runId, entry);
		if (entry.pending) return entry.pending;
		const poll = async () => {
			for (let pageIndex = 0; pageIndex < PAGES_PER_POLL; pageIndex++) {
				const page = await this.fetchPage(runId, entry.cursor);
				const merged = [
					...new Map(
						[...(entry.detail?.steps ?? []), ...page.steps].map((step) => [step.id, step])
					).values()
				];
				if (merged.length > RECENT_STEPS) entry.beforeFirst = merged.at(-RECENT_STEPS - 1)?.id;
				const steps = merged.slice(-RECENT_STEPS);
				entry.detail = { ...page, steps };
				// `after=null` means caught up, not reset. Keep the last step as the cursor for the next poll.
				const next = page.after ?? page.steps.at(-1)?.id ?? entry.cursor;
				const previous = entry.cursor;
				entry.cursor = next;
				if (!page.after) {
					// Tool ids persist while results arrive; overlap the earliest pending call, including parallel calls.
					const pendingTool = steps.findIndex((step) => step.type === 'tool' && step.ok === null);
					if (pendingTool >= 0)
						entry.cursor = pendingTool > 0 ? steps[pendingTool - 1].id : entry.beforeFirst;
					break;
				}
				if (next === previous) break;
			}
			return entry.detail!;
		};
		const pending = poll().finally(() => {
			entry.pending = undefined;
		});
		entry.pending = pending;
		return pending;
	}
}

export function latestActivity(steps: RunStep[]): string | undefined {
	const last = steps.findLast((step) => step.type === 'tool' || step.type === 'assistant');
	return last?.type === 'tool'
		? last.name.replaceAll('_', ' ')
		: last?.type === 'assistant'
			? last.text
			: undefined;
}
