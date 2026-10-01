import type { AskView, PendingApproval } from '$lib/features/chat';
import type { RunSummary } from '$lib/features/runs';

/** An open, undismissed job-alert streak (M23-ARCH `HomeAlert`). */
export interface HomeAlert {
	/** "job:<name>" */
	id: string;
	job: string;
	kind: 'failed' | 'stuck';
	/** Streak start. */
	firstAt: string;
	lastAt: string;
	trigger: string;
	error?: string;
	schedule: string;
	disabled?: boolean;
	runId?: string;
	seq: number;
}

/**
 * GET /api/home without the parts the stream keeps live: pending approvals, asks and open Main
 * turns come from the hub. `review` is not in the pinned HomeResponse yet.
 */
export interface HomeData {
	asOf: string;
	/** Newest unresolved sign-in link. */
	auth: { seq: number; at: string; key: string } | null;
	failed: HomeAlert[];
	workspace:
		| {
				state: 'online';
				running: RunSummary[];
				/** Background runs that failed in the last 72 h, not dismissed. */
				failedRuns: RunSummary[];
				/** Finished background or scheduled runs not opened yet. */
				review: RunSummary[];
		  }
		| { state: 'offline' | 'unsupported' | 'timeout' };
}

/** A Main turn in flight. */
export interface TurnItem {
	turnId: string;
	startedAt: number;
	/** The current step in plain words, when a tool is running. */
	step?: string;
	toolCount: number;
}

export type HomeGroup = 'waiting' | 'failed' | 'running' | 'review';

export type HomeItem =
	| { id: string; group: 'waiting'; kind: 'approval'; at: string; approval: PendingApproval }
	| { id: string; group: 'waiting'; kind: 'ask'; at: string; ask: AskView }
	| { id: string; group: 'waiting'; kind: 'auth'; at: string }
	| { id: string; group: 'failed'; kind: 'alert'; at: string; alert: HomeAlert }
	| { id: string; group: 'failed' | 'running' | 'review'; kind: 'run'; at: string; run: RunSummary }
	| { id: string; group: 'running'; kind: 'turn'; at: string; turn: TurnItem };

export type HomeGroups = Record<HomeGroup, HomeItem[]>;

/** What the peek sheet shows. */
export interface HomePeek {
	id: string;
	/** Missing: the item is no longer there (or could not be checked). */
	item?: HomeItem;
	missing?: 'handled' | 'offline';
	/** An approval decision being sent from the sheet. */
	submitting?: boolean;
	/** What happened to what you did here; failures can be retried. */
	result?: { ok: boolean; text: string };
}

export type HomeSheet = 'peek';
