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

/** Workspace-issued run id (ULID). A lookup key only; the bot never puts it in a path. */
export const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** A History day in the host's own time zone. The bot also checks it names a real calendar date. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const JOB_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const RUN_KINDS = ['chat', 'flush', 'job', 'subagent', 'agent', 'rotate'] as const;
export const RUN_STATUSES = ['running', 'done', 'failed', 'aborted', 'timeout'] as const;
/** Code points after trimming. */
export const SEARCH_QUERY_MIN = 2;
export const SEARCH_QUERY_MAX = 200;
/** Hits in one merged search response, both sources together. */
export const SEARCH_HITS_MAX = 20;
/** How far back Home looks for failed and finished background runs. */
export const HOME_RECENT_HOURS = 72;
/** Per Home run list (`running`, `failedRuns`, `review`). */
export const HOME_RUNS_MAX = 20;

/** Supported live screens advertised to compatibility clients; all implemented screens are available. */
export const WEB_FEATURES = [
	'runs',
	'history',
	'home',
	'alerts',
	'connectors',
	'threads',
	'memory'
] as const;
export type WebFeature = (typeof WEB_FEATURES)[number];

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
	id?: string;
	/** UTF-16 position in assistant text when this call began. */
	textOffset?: number;
	name: string;
	summary: string;
	state: 'run' | 'ok' | 'err';
	agentId?: string;
}

/** A running turn's live view. */
export interface ProgressView {
	modelActivity?: 'waiting' | 'thinking';
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
export interface ToolConfirmation {
	tool: string;
	input: string;
	reason?: string;
	toolCallId?: string;
}

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
		toolConfirmation?: ToolConfirmation;
	}[];
}

export type RunKind = (typeof RUN_KINDS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
	model?: string;
}

/** One run as the workspace host recorded it. Agent-writable: show it as the agent's record. */
export interface RunSummary {
	conversationId?: string;
	repo?: string;
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

/** Why a run's steps may be empty. */
export type RunSession = 'ok' | 'missing' | 'outside' | 'not-session';

/** An approval from the bot's own log, shown read-only on a run. */
export interface RunApprovalRecord {
	nonce: string;
	at: string;
	tool: string;
	decision: ApprovalDecision | null;
}

/** A scheduled job's failure streak event, as the workspace sent it. */
export interface JobAlert {
	source: 'job';
	job: string;
	kind: 'failed' | 'stuck' | 'recovered';
	trigger: 'daily' | 'interval' | 'catchup' | 'manual';
	startedAt: string;
	/** One line, redacted. */
	error?: string;
	schedule: string;
	/** A disabled job only runs on demand, so it won't retry on its own. */
	disabled?: boolean;
	runId?: string;
}

/** An open, undismissed job-alert streak (bot table `web_alerts`). */
export interface HomeAlert {
	/** "job:<name>" */
	id: string;
	job: string;
	kind: 'failed' | 'stuck';
	/** Streak start. */
	firstAt: string;
	lastAt: string;
	trigger: JobAlert['trigger'];
	error?: string;
	schedule: string;
	disabled?: boolean;
	runId?: string;
	/** The `alert` event, for seen receipts. */
	seq: number;
}

// ── SSE events ──

/** Snapshot captured at a context boundary; later memory edits do not change it. */
export interface SessionBoundary {
	kind: 'new' | 'rotated' | 'compacted';
	summary?: string;
	summaryTruncated?: boolean;
	memory?: {
		files: {
			path: string;
			content: string;
			truncated: boolean;
			change: 'added' | 'changed' | 'removed';
		}[];
		truncated: boolean;
	};
	context?: { files: { path: string; content: string; truncated: boolean }[]; truncated: boolean };
	initialContext?: string;
}

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
	ask: {
		key: string;
		askId: string;
		question: string;
		choices: string[];
		toolConfirmation?: ToolConfirmation;
	};
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
		lines?: ToolLine[];
		activityText?: string;
	};
	/** `clientId` is the owner message this notice answers, and settles it, except `messageRejected`,
	 *  which fails it until a retry. It is never set on `workspaceOffline`, which asks the client to resend. */
	notice: RouterNotice & { clientId?: string };
	session: SessionBoundary;
	snapshot: { turnId: string; view: ProgressView };
	/** Apply only when `offset` equals the local text length; otherwise wait for a snapshot. */
	delta: { turnId: string; offset: number; text: string };
	tool: {
		turnId: string;
		name: string;
		summary: string;
		ok?: boolean;
		id?: string;
		textOffset?: number;
		agentId?: string;
	};
	workspace: { state: WorkspaceState };
	/** `key` is the workspace outbox id. `text` is the alert as plain text, for a client that can't show it. */
	alert: { key: string; alert: JobAlert; text: string };
	alert_cleared: { id: string; reason: 'recovered' | 'dismissed' };
	/** A scheduled job's message reached Home's inbox; `key` is its outbox key. */
	inbox: { key: string };
	/** A background run started or ended; refetch what shows it. */
	/** Refetch topic metadata and the Chats list; conversation content stays on its own stream. */
	threads: { id: string };
	run: {
		conversationId?: string;
		repo?: string;
		runId: string;
		kind: RunKind;
		status: RunStatus;
		parentRunId?: string;
		jobName?: string;
	};
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
	'session',
	'alert',
	'alert_cleared'
] as const;
/** Fanned out to open streams only, never stored. */
export const EPHEMERAL_EVENTS = [
	'snapshot',
	'delta',
	'tool',
	'workspace',
	'run',
	'inbox',
	'threads'
] as const;

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

/** GET /api/chat/history, read from the bot's own chat log. */
export type WebHistoryItem =
	| {
			type: 'user';
			id: string;
			clientId?: string;
			at: string;
			text: string;
			/** `file` is null when the upload is unknown to the bot: render a dead placeholder. */
			attachments: { name: string; contentType: string; file: UploadRef | null }[];
	  }
	| {
			type: 'assistant';
			id: string;
			at: string;
			text: string;
			outboxId?: string;
			turnId?: string;
			activityText?: string;
			tools: {
				name: string;
				summary: string;
				ok: boolean;
				id?: string;
				textOffset?: number;
				agentId?: string;
			}[];
			usage?: ChatUsage;
			files: UploadRef[];
	  }
	| {
			type: 'ask';
			id: string;
			at: string;
			outboxId: string;
			askId: string;
			question: string;
			choices: string[];
			toolConfirmation?: ToolConfirmation;
			/** Null: no longer waiting, and never answered. */
			answer?: string | null;
	  }
	| ({ type: 'divider'; id: string; at: string } & SessionBoundary)
	| {
			/** Only ever from the bot's approval log. `decision` is null while still pending. */
			type: 'approval';
			id: string;
			at: string;
			nonce: string;
			view: ApprovalView;
			decision: ApprovalDecision | null;
	  }
	| {
			/** A scheduled job's alert; `outboxId` is the live `alert` event's `key`. */
			type: 'alert';
			id: string;
			at: string;
			outboxId: string;
			alert: JobAlert;
			text: string;
	  };

export interface HistoryResponse {
	items: WebHistoryItem[];
	/** Cursor for the next older page; null at the start of the chat. */
	before: string | null;
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

/** GET /api/me. */
export interface MeResponse {
	login: string;
	displayName?: string;
	features: WebFeature[];
	/** POST /api/dictation turns speech into text. Absent from an older bot. */
	dictation?: boolean;
}

/**
 * The workspace part of a bot response could not be had. 501 `unsupported`: an older workspace;
 * 503 `offline`; 504 `timeout`; 502 `bad_response`: it answered something outside the contract.
 */
export type WorkspaceUnavailableResponse =
	{ unsupported: true } | { offline: true } | { timeout: true } | { bad_response: true };

/** GET /api/home. The bot part is always there; the workspace part waits at most 3 s. */
export interface HomeResponse {
	asOf: string;
	waiting: {
		approvals: PendingState['approvals'];
		asks: PendingState['asks'];
		/** The newest unresolved sign-in link. */
		auth: { seq: number; at: string; key: string } | null;
	};
	/** Main turns in flight. */
	openTurns: TurnView[];
	/** Open, undismissed job alerts, newest first. */
	failed: HomeAlert[];
	/** Scheduled-job messages not yet marked done, newest first. */
	inbox: HomeMessage[];
	workspace:
		| {
				state: 'online';
				/** Running `job`, `subagent` and `agent` runs, newest first. */
				running: RunSummary[];
				/** `subagent` and `agent` runs that ended `failed` or `timeout` within HOME_RECENT_HOURS, not dismissed. */
				failedRuns: RunSummary[];
				/** `agent` runs that ended `done` within HOME_RECENT_HOURS, not marked done. */
				review: ReviewRun[];
		  }
		/** `bad_response`: the workspace answered outside the contract. */
		| { state: 'offline' | 'unsupported' | 'timeout' | 'bad_response' };
}

/** A scheduled job's message, kept on Home until marked done. */
export interface HomeMessage {
	/** The workspace outbox id; the Home item id is `msg:<key>`. */
	key: string;
	job: string;
	runId?: string;
	text: string;
	at: string;
	read: boolean;
}

export type ReviewRun = RunSummary & { read: boolean };

/**
 * POST /api/home/dismiss → 204. A `job:` id hides the alert until its next failure; `run:` and `msg:` mark a
 * run or a message done, on every device.
 */
export interface HomeDismissBody {
	id: string;
}

/** POST /api/home/restore → 204. Undoes a dismiss of a `run:` or `msg:` id. */
export interface HomeRestoreBody {
	id: string;
}

/**
 * POST /api/home/opened → 204. Marks a `run:` or `msg:` item read on every device; it stays until marked done.
 * The bot keeps the opened set 30 days, longer than HOME_RECENT_HOURS.
 */
export interface HomeOpenedBody {
	id: string;
}

/**
 * GET /api/models: the owner's model choice. POST /api/models {alias} switches it from the next turn and
 * answers the same shape. 501/503/504/502 as WorkspaceUnavailableResponse.
 */
export interface ConversationContext {
	tokens: number;
	window: number;
	percent: number;
	estimated: boolean;
	compactAt: number | null;
	model: string | null;
	status: 'ready' | 'updating' | 'compacting';
}

export interface ModelsResponse {
	/** Current conversation context, independently of historical reply usage. */
	context?: ConversationContext | null;
	/** The chosen alias, or an OpenRouter id picked outside the list; null on a default no entry matches. */
	current: string | null;
	models: ({ alias: string; backend: 'chatgpt' | 'openrouter'; id: string } & ModelFacts)[];
	/** The OpenRouter model a ChatGPT choice falls back to; absent from an older agent. */
	fallback?: string;
	/** While set, ChatGPT is cooling down and the fallback answers. */
	fallbackUntil?: string | null;
	/** Recorded USD costs; session is the current conversation context, today spans all runs. */
	cost?: {
		session?: HistoryCost;
		today: HistoryCost;
		date: string;
		timeZone: string;
		truncated?: boolean;
	};
}

/** From OpenRouter's catalog when it could be read; prices are USD per million tokens. */
export interface ModelFacts {
	contextWindow?: number;
	priceIn?: number | null;
	priceOut?: number | null;
	image?: boolean;
}

/** GET /api/models/search?q=: tool-capable OpenRouter models, cheapest first. POST /api/models takes
 *  {alias, role?: 'main' | 'fallback'}, where alias may be any id from here. */
export interface ModelsSearchResponse {
	models: ({ id: string; name: string } & ModelFacts)[];
}

/** GET /api/runs?before=&limit=&kind=&status= (`kind` and `status` are comma lists). */
export interface RunsPage {
	runs: RunSummary[];
	/** Cursor for older runs; null when there are none. */
	before: string | null;
	/** Older runs exist past the scan bound; they are reachable through History. */
	truncated: boolean;
}

/** GET /api/runs/:runId?after=&limit=. 404 when the run is not found. */
export interface RunDetailResponse {
	run: RunSummary;
	parent?: RunSummary;
	children: RunSummary[];
	session: RunSession;
	steps: RunStep[];
	/** Cursor for the next steps; null when the last step is here. */
	after: string | null;
	/** First page only. */
	evidence?: RunEvidence;
	/** "YYYY-MM/DD-<runId>.md", for the History link. */
	historyFile?: string;
	/** From the bot's approval log (30 days). */
	approvals: RunApprovalRecord[];
	/** Files the bot delivered for this run's turn, matched by turnId. */
	files: UploadRef[];
}

/** Recorded model cost, counted once per run; subscription and missing prices are unpriced. */
export interface HistoryCost {
	usd: number;
	recordedRuns: number;
	unpricedRuns: number;
}

export interface HistoryDay {
	date: string;
	runs: number;
	sessions: number;
	cost?: HistoryCost;
}

/** GET /api/history/days?before=&limit=. */
export interface HistoryDaysPage {
	days: HistoryDay[];
	/** Cursor for older days; null when there are none. */
	before: string | null;
}

/** GET /api/history/days/:date. */
export type HistoryDayResponse =
	| { found: false }
	| {
			found: true;
			date: string;
			/** The day's `## Sessions` recaps, as the agent wrote them. */
			sessions: { heading: string; markdown: string }[];
			/** Runs that started that local day. */
			runs: RunSummary[];
			cost?: HistoryCost;
			/** The day's file was larger than the read cap. */
			truncated: boolean;
	  };

/** [start, end) in code points of `snippet`. */
export type SearchRange = [number, number];

/** A match in the agent's notes under ~/history. */
export interface NotesHit {
	source: 'notes';
	/** "<relPath>:<line>" */
	id: string;
	kind: 'daily' | 'run';
	date: string;
	runId?: string;
	line: number;
	/** The nearest heading above the match. */
	heading?: string;
	snippet: string;
	ranges: SearchRange[];
}

/** A match in the chat the bot stores. */
export interface ChatHit {
	source: 'chat';
	/** The matching message's WebHistoryItem id. */
	id: string;
	at: string;
	role: 'user' | 'agent';
	snippet: string;
	ranges: SearchRange[];
}

export type SearchHit = NotesHit | ChatHit;

/**
 * GET /api/search?q=. Chat and notes merged newest first, at most SEARCH_HITS_MAX. A notes hit sorts as
 * `<date>T23:59:59Z`. No cursor: a narrower query is the way to older matches.
 */
export interface SearchResponse {
	/** The trimmed query this answers. */
	query: string;
	hits: SearchHit[];
	/** A source stopped early or had more matches than fit, so some are missing. */
	truncated: boolean;
	/** Sources that could not be searched this time (offline, older workspace, or busy). */
	unavailable: ('chat' | 'notes')[];
}
