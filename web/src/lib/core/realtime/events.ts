// Byte-identical in src/surfaces/web/events.ts and web/src/lib/core/realtime/events.ts (a root test enforces it),
// so it imports nothing and follows the web prettier config.

// ── Ids and limits ──

/** App-issued message id (ULID): the idempotency key of POST /api/chat/messages and of the `user` event. */
export const CLIENT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Bot-issued upload id: 128-bit random base64url. */
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const MESSAGE_TEXT_MAX = 16_000;
export const MESSAGE_UPLOADS_MAX = 10;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const HISTORY_LIMIT_MAX = 100;

/** Where the app loads an upload's bytes. */
export function fileUrl(id: string): string {
	return `/f/${id}`;
}

/** True only for an absolute URL whose parsed scheme is https: (the WHATWG parser strips tabs and newlines first). */
export function isHttpsUrl(s: string): boolean {
	try {
		return new URL(s).protocol === 'https:';
	} catch {
		return false;
	}
}

// ── Shared views (wire copies of bot types) ──

export type WorkspaceState = 'online' | 'offline';

export interface ChatUsage {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
	contextPct?: number;
}

/** A stored file. `inline` is true only for a sniffed png, jpeg, gif or webp. */
export interface UploadRef {
	id: string;
	contentType: string;
	bytes: number;
	name: string;
	inline: boolean;
}

export interface ToolLine {
	name: string;
	summary: string;
	state: 'run' | 'ok' | 'err';
	agentId?: string;
}

/** A running turn's live view. */
export interface ProgressView {
	turnId: string;
	startedAt: number;
	lines: readonly ToolLine[];
	toolCount: number;
	text: string;
}
export type TurnView = ProgressView;

export type TurnOutcome = 'done' | 'stopped' | 'interrupted';

export type ApprovalField =
	| { key: string; value: string; kind: 'single'; max: number }
	| { key: string; value: string; kind: 'body' };

export interface ApprovalView {
	tool: string;
	/** Self-reported by the workspace. */
	agentId: string;
	agentName: string;
	fields: ApprovalField[];
}

/** `cancelled`: the workspace withdrew the call because its turn was stopped. */
export type ApprovalDecision = 'approve' | 'deny' | 'timeout' | 'cancelled';

export type ToolCallResult =
	{ ok: true; result: string } | { ok: false; error: string; denied?: boolean };

export type RouterNotice =
	| { type: 'workspaceOffline' }
	| { type: 'newSessionStarted' }
	| { type: 'newSessionFailed'; error: string }
	| { type: 'newWhileOffline' }
	| { type: 'nothingToStop' }
	| { type: 'stopFailed'; error: string }
	| { type: 'transcriptionFailed' }
	| { type: 'transcript'; text: string }
	| { type: 'approvalExpired' }
	| { type: 'askAlreadyAnswered' }
	| { type: 'askNotDelivered'; error: string }
	| { type: 'loginOffline' }
	| { type: 'loginAlreadyPending' }
	| { type: 'loginNotPending' }
	| { type: 'loginCallbackIgnored' }
	| { type: 'loginCallbackRejected'; error: string }
	| { type: 'loginFailed'; error: string }
	| { type: 'loginUsage' }
	| { type: 'commandResult'; text: string }
	| { type: 'commandOffline' }
	| { type: 'commandFailed'; error: string }
	/** The workspace is connected but refused the message; it stays unsent until a retry. */
	| { type: 'messageRejected'; error: string };

/** Unresolved items from the bot's own log, carried on the first frame so showing them never depends
 *  on the workspace's history. */
export interface PendingState {
	/** Approvals still waiting for a decision, oldest first. */
	approvals: { seq: number; at: string; nonce: string; view: ApprovalView }[];
	/** The newest unanswered asks, oldest first. */
	asks: {
		seq: number;
		at: string;
		key: string;
		askId: string;
		question: string;
		choices: string[];
	}[];
}

// ── SSE events ──

/** Payload of each SSE event, by event name. */
export interface ChatEventMap {
	hello: {
		headSeq: number;
		workspace: WorkspaceState;
		openTurns: TurnView[];
		pending: PendingState;
	};
	/** `after` is outside the retained range: drop the local tail and reload history. */
	reset: { headSeq: number; workspace: WorkspaceState; pending: PendingState };
	user: { key: string; text: string; uploadIds: string[]; at: string };
	status: { clientId: string; state: 'accepted' | 'steer' | 'queued' | 'stopped' | 'newSession' };
	reply: { key: string; turnId?: string; text: string; usage?: ChatUsage; files: UploadRef[] };
	proactive: { key: string; turnId?: string; text: string; usage?: ChatUsage; files: UploadRef[] };
	ask: { key: string; askId: string; question: string; choices: string[] };
	/** A null `answer`: the ask is no longer waiting (it timed out, or the workspace restarted). */
	ask_resolved: { askId: string; answer: string | null };
	/** Render `url` as a link only when isHttpsUrl(url); otherwise as inert text. */
	auth: { key: string; url: string; instructions: string };
	approval: { nonce: string; view: ApprovalView };
	approval_resolved: { nonce: string; decision: ApprovalDecision; result?: ToolCallResult };
	turn_final: {
		turnId: string;
		outcome: TurnOutcome;
		summary: { durationMs: number; toolCount: number } | null;
	};
	/** `clientId` is the owner message this notice answers, and settles it, except `messageRejected`,
	 *  which fails it until a retry. It is never set on `workspaceOffline`, which asks the client to resend. */
	notice: RouterNotice & { clientId?: string };
	session: { kind: 'new' | 'compacted' };
	snapshot: { turnId: string; view: ProgressView };
	/** Apply only when `offset` equals the local text length; otherwise wait for a snapshot. */
	delta: { turnId: string; offset: number; text: string };
	tool: { turnId: string; name: string; summary: string; ok?: boolean };
	workspace: { state: WorkspaceState };
}
export type ChatEventType = keyof ChatEventMap;

export const FIRST_FRAME_EVENTS = ['hello', 'reset'] as const;
/** Stored in web_events with a `seq` (the SSE `id:`), replayed on reconnect. */
export const DURABLE_EVENTS = [
	'user',
	'status',
	'reply',
	'proactive',
	'ask',
	'ask_resolved',
	'auth',
	'approval',
	'approval_resolved',
	'turn_final',
	'notice',
	'session'
] as const;
/** Fanned out to open streams only, never stored. */
export const EPHEMERAL_EVENTS = ['snapshot', 'delta', 'tool', 'workspace'] as const;

export type FirstFrameEventType = (typeof FIRST_FRAME_EVENTS)[number];
export type DurableEventType = (typeof DURABLE_EVENTS)[number];
export type EphemeralEventType = (typeof EPHEMERAL_EVENTS)[number];

export function isDurableEvent(type: string): type is DurableEventType {
	return (DURABLE_EVENTS as readonly string[]).includes(type);
}

/** One decoded SSE frame. `seq` is set on durable events only. */
export type ChatEnvelope = {
	[T in ChatEventType]: {
		seq?: number;
		type: T;
		data: ChatEventMap[T];
	};
}[ChatEventType];

// ── HTTP API ──

/** GET /api/chat/history. A `user`, `assistant` or `ask` item with `verified: false` came only from the
 *  workspace transcript; it renders like any other message but never gets Retry/Delete. */
export type WebHistoryItem =
	| {
			type: 'user';
			id: string;
			clientId?: string;
			at: string;
			text: string;
			/** `file` is null when the upload is unknown to the bot: render a dead placeholder. */
			attachments: { name: string; contentType: string; file: UploadRef | null }[];
			verified: boolean;
	  }
	| {
			type: 'assistant';
			id: string;
			at: string;
			text: string;
			outboxId?: string;
			turnId?: string;
			tools: { name: string; summary: string; ok: boolean }[];
			usage?: ChatUsage;
			files: UploadRef[];
			verified: boolean;
	  }
	| {
			type: 'ask';
			id: string;
			at: string;
			outboxId: string;
			askId: string;
			question: string;
			choices: string[];
			/** Null: no longer waiting, and never answered. */
			answer?: string | null;
			verified: boolean;
	  }
	| {
			type: 'divider';
			id: string;
			at: string;
			kind: 'new' | 'rotated' | 'compacted';
			summary?: string;
	  }
	| {
			/** Only ever from the bot's approval log. `decision` is null while still pending. */
			type: 'approval';
			id: string;
			at: string;
			nonce: string;
			view: ApprovalView;
			decision: ApprovalDecision | null;
	  };

export interface HistoryResponse {
	items: WebHistoryItem[];
	/** Cursor for the next older page; null at the start of the transcript. */
	before: string | null;
}
/** 503 body when the workspace is down. */
export interface HistoryOfflineResponse {
	offline: true;
}
/** 501 body when the workspace can't serve history. */
export interface HistoryUnsupportedResponse {
	unsupported: true;
}
/** 409 body when the workspace no longer knows `before`: drop the loaded pages and reload from the newest. */
export interface HistoryResetResponse {
	reset: true;
}

export interface PostMessageBody {
	clientId: string;
	text: string;
	uploadIds?: string[];
}
export interface PostMessageResponse {
	seq: number;
	/** The workspace already took the message, so the client can drop its outbox entry. */
	routed: boolean;
}
/** 409 body when an upload the message names is gone; nothing was stored. */
export interface PostMessageUploadMissingResponse {
	error: 'upload_missing';
	ids: string[];
}

/**
 * `DELETE /api/chat/messages/:clientId`, before the client drops a posted message. 200: the bot will never
 * deliver it. 409 with `DiscardMessageRoutedResponse`: it already reached the agent. 404: the bot never
 * stored it. A later POST of a discarded clientId answers 410 with `DiscardMessageResponse`.
 */
export interface DiscardMessageResponse {
	discarded: true;
}
export interface DiscardMessageRoutedResponse {
	routed: true;
}

export interface PostStopBody {
	turnId?: string;
}

export interface PostCommandBody {
	command: 'new' | 'compact';
}

/** `label` lets the bot match the choice after a restart emptied its choice list. */
export type PostAskBody = { index: number; label: string } | { text: string };
export interface PostAskResponse {
	status: 'answered' | 'duplicate' | 'inactive' | 'failed';
}

export interface PostApprovalBody {
	decision: 'approve' | 'deny';
}
export interface PostApprovalResponse {
	status: 'decided' | 'expired';
}

export interface PostSeenBody {
	seq: number;
}

/** POST /api/uploads: raw image body with `X-Upload-Name` and `X-Client-Id` headers. */
export interface UploadResponse {
	id: string;
	contentType: string;
	bytes: number;
	width?: number;
	height?: number;
}
