// The run shapes M23-ARCH pins (runSummary, runStep, runEvidence, RunDetailResponse), mirrored here
// until they land in the wire copy of events.ts.
import type { ApprovalDecision, UploadRef } from '$lib/core/realtime/events';

export const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const RUN_KINDS = ['chat', 'flush', 'job', 'subagent', 'agent', 'rotate'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_STATUSES = ['running', 'done', 'failed', 'aborted', 'timeout'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
	model?: string;
}

export interface RunSummary {
	runId: string;
	parentRunId?: string;
	turnId?: string;
	kind: RunKind;
	agentName: string;
	jobName?: string;
	/** One line, redacted: the first user text or the task. */
	title: string;
	status: RunStatus;
	startedAt: string;
	endedAt?: string;
	usage?: RunUsage;
	/** One line, redacted. */
	resultSummary?: string;
}

export interface RunsPage {
	runs: RunSummary[];
	/** Cursor for older runs; null when there are none. */
	before: string | null;
	/** Older runs exist past the scan bound; they are reachable through History. */
	truncated: boolean;
}

export type RunStep =
	| { type: 'user'; id: string; at: string; text: string }
	| { type: 'assistant'; id: string; at: string; text: string }
	| {
			type: 'tool';
			id: string;
			at: string;
			name: string;
			args: string;
			/** null: no result inside the run's window. */
			ok: boolean | null;
			result: string;
			durationMs?: number;
			agentId?: string;
	  }
	| {
			type: 'note';
			id: string;
			at: string;
			kind: 'compaction' | 'verify' | 'error' | 'aborted' | 'custom';
			text: string;
	  };

export interface RunEvidence {
	checks: { command: string; ok: boolean | null; at: string }[];
	changedRepos: string[];
	/** null: nothing under projects/ changed. */
	checkAfterLastChange: boolean | null;
	verifyNudged: boolean;
	filesSent: { name: string; at: string }[];
	memoryWrites: { path: string; tool: 'write' | 'edit' | 'bash'; at: string }[];
}

export type RunSession = 'ok' | 'missing' | 'outside' | 'not-session';

export interface RunApprovalRecord {
	nonce: string;
	at: string;
	tool: string;
	decision: ApprovalDecision | null;
}

/** GET /api/runs/:runId. */
export interface RunDetail {
	run: RunSummary;
	parent?: RunSummary;
	children: RunSummary[];
	session: RunSession;
	steps: RunStep[];
	/** Cursor for the next steps; null when the last step is here. */
	after: string | null;
	evidence?: RunEvidence;
	/** "YYYY-MM/DD-<runId>.md", for the History link. */
	historyFile?: string;
	/** From the bot's approval log. */
	approvals: RunApprovalRecord[];
	/** Files the bot delivered for this run's turn. */
	files: UploadRef[];
}
