import type { HomeAlert, HomeResponse } from '$lib/core/realtime/events';
import type { AskView, PendingApproval } from '$lib/features/chat';
import type { RunSummary } from '$lib/features/runs';

export type { HomeAlert };

/**
 * GET /api/home without the parts the stream keeps live: pending approvals, asks and open Main
 * turns come from the hub, so only the sign-in link is kept from `waiting`.
 */
export type HomeData = Omit<HomeResponse, 'waiting' | 'openTurns'> & {
	auth: HomeResponse['waiting']['auth'];
};

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
