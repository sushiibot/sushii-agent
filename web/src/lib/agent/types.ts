import type { UploadRef } from '$lib/chat/events';

export type RunState = 'waiting' | 'running' | 'review' | 'failed' | 'done';
export type Outcome = 'verified' | 'unverified';

export interface InboxItem {
	id: string;
	state: RunState;
	title: string;
	source: string;
	when: string;
	summary: string;
	question?: string;
	runId?: string;
	tainted?: boolean;
	/** Approvals and asks deep-link to the tray or card instead of opening a peek. */
	kind?: 'approval' | 'ask';
	href?: string;
}

export interface ToolCall {
	id: string;
	name: string;
	summary: string;
	at: string;
	ms: number;
	status: 'ok' | 'error' | 'approved' | 'denied';
	detail?: string;
	taints?: boolean;
}

export interface Evidence {
	kind: 'message-id' | 'readback' | 'http' | 'file' | 'screenshot';
	label: string;
	value: string;
}

export interface Run {
	id: string;
	title: string;
	trigger: string;
	started: string;
	duration: string;
	cost: string;
	model: string;
	state: RunState;
	outcome: Outcome;
	outcomeNote: string;
	tainted?: { by: string; locked: string[] };
	steps: ToolCall[];
	evidence: Evidence[];
	file: string;
}

export interface DiffLine {
	kind: 'add' | 'del' | 'ctx';
	text: string;
}

export interface MemoryChange {
	id: string;
	file: string;
	summary: string;
	when: string;
	commit: string;
	run: { id: string; title: string };
	session?: { id: string; title: string };
	taint?: string;
	diff: DiffLine[];
}

export type SkillStage = 'draft' | 'active' | 'stale' | 'archived';

export interface Skill {
	name: string;
	description: string;
	stage: SkillStage;
	uses: number;
	successRate: number;
	lastUsed: string;
	reason: string;
	history: { when: string; event: string; reason: string }[];
	runs: { id: string; title: string; ok: boolean; when: string }[];
}

export type LastResult = 'sent' | 'quiet' | 'suppressed' | 'failed' | 'skipped' | 'outside-hours';

export interface Job {
	id: string;
	name: string;
	schedule: string;
	next: string;
	enabled: boolean;
	last: { result: LastResult; when: string; note: string };
	history: { when: string; result: LastResult; note: string }[];
}

export interface McpTool {
	name: string;
	description: string;
	change?: 'added' | 'removed';
}

export interface McpServer {
	name: string;
	url: string;
	status: 'connected' | 'error';
	connectedAt: string;
	tools: McpTool[];
	history: { when: string; event: string }[];
	usedBy: { runId: string; title: string; tool: string; when: string }[];
}

export interface BriefItem {
	id: string;
	section: 'Top of mind' | 'Looking ahead';
	title: string;
	detail: string;
	source: { label: string; href: string };
}

export interface DaySummary {
	date: string;
	summary: string;
	sessions: { id: string; title: string; time: string; messages: number }[];
	runs: { id: string; title: string; time: string; state: RunState; outcome: Outcome }[];
}

// Mirrors AI SDK UIMessage parts so the real app can render SDK messages with the same components.
export type ToolPartState =
	| 'input-streaming'
	| 'input-available'
	| 'approval-requested'
	| 'approval-responded'
	| 'output-available'
	| 'output-denied';

export type MessagePart =
	| { type: 'text'; text: string }
	| { type: 'data-thread-offer'; data: { title: string; reason: string; openedAs?: string } }
	| { type: 'data-thread-brief'; data: ThreadBrief }
	| { type: 'data-thread-report'; data: ThreadReport }
	| { type: 'data-notice'; data: { source: string; items: string[]; href: string } }
	| { type: 'data-memory-write'; data: MemoryWrite }
	| { type: 'data-auth'; data: { instructions: string; url: string; https: boolean } }
	| { type: 'data-turn'; data: Turn }
	| { type: 'data-approval'; data: { tool: string; outcome: ApprovalOutcome } }
	| { type: 'data-ask'; data: AskView }
	| { type: 'data-files'; data: { files: FileRef[]; dropped?: string } }
	| { type: 'data-divider'; data: { kind: 'new' | 'rotated' | 'compacted'; summary?: string } }
	| { type: 'data-history-gap' }
	| { type: 'data-line'; data: { text: string } }
	| {
			type: `tool-${string}`;
			toolCallId: string;
			state: ToolPartState;
			input: Record<string, string>;
			output?: Record<string, string>;
			approval?: { id: string; approved?: boolean };
	  };

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: MessagePart[];
	delivery?: Delivery;
	/** Still receiving deltas; the bubble reserves its height. */
	streaming?: boolean;
	/** The bot's files for this reply, as sent; the markdown renderer inlines only these. */
	uploads?: readonly UploadRef[];
}

export type Delivery = 'sending' | 'sent' | 'failed' | 'queued' | 'queued-agent';

// Parsed markdown, rendered through components; raw HTML never reaches the DOM.
export type MdInline =
	{ kind: 'text' | 'strong' | 'code'; text: string } | { kind: 'link'; text: string; href: string };
export type MdBlock = { kind: 'heading'; text: string } | { kind: 'p'; inlines: MdInline[] };

// Mirrors the bot's ApprovalView; the web package can't import the bot's sources.
export type ApprovalField =
	| { key: string; value: string; kind: 'single'; max: number }
	| { key: string; value: string; kind: 'body' };

export interface ApprovalView {
	tool: string;
	agentId: string;
	agentName: string;
	fields: ApprovalField[];
}

export interface PendingApproval {
	nonce: string;
	view: ApprovalView;
	/** Why this call asked even if an allow rule exists. */
	tainted?: string;
}

export type ApprovalOutcome =
	| 'pending'
	| 'approved'
	| 'denied'
	| 'timeout'
	| 'cancelled'
	| 'approved-elsewhere'
	| 'denied-elsewhere';

export type AskState = 'pending' | 'answering' | 'answered' | 'elsewhere' | 'history';

export interface AskView {
	askId: string;
	question: string;
	choices: string[];
	state: AskState;
	answer?: string;
}

export interface TurnStep {
	id: string;
	tool: string;
	/** Plain words: "Searching mail for 'invoice'". */
	label: string;
	state: 'running' | 'ok' | 'failed';
	input: string;
	output?: string;
}

export interface Turn {
	state: 'working' | 'thinking' | 'done' | 'stopping' | 'stopped';
	steps: TurnStep[];
	elapsed?: string;
	/** Replaces the step text for command turns ("Starting a new chat…"). */
	label?: string;
}

export interface FileRef {
	id: string;
	name: string;
	size: string;
	/** Sniffed raster images render inline; everything else is a download. */
	image: boolean;
	src?: string;
	removed?: boolean;
}

export interface PhotoDraft {
	id: string;
	name: string;
	src: string;
	state: 'preparing' | 'uploading' | 'uploaded' | 'failed';
	progress?: number;
	error?: 'upload' | 'type' | 'size' | 'daily' | 'expired';
}

export type ConnectionState =
	| { kind: 'offline' }
	| { kind: 'reconnecting'; elapsed?: string }
	| { kind: 'agent-offline' }
	| { kind: 'reset' };

export type PushState = 'default' | 'granted' | 'denied' | 'unsupported';

// `project` (repo-scoped coding sessions) is reserved for later.
export type SessionKind = 'main' | 'thread' | 'project';
export type SessionState = 'needs-you' | 'running' | 'idle' | 'archived';

export interface Session {
	id: string;
	kind: SessionKind;
	title: string;
	state: SessionState;
	lastActivity: string;
	preview: string;
	unread?: number;
}

export interface MemoryWrite {
	id: string;
	file: string;
	summary: string;
	when: string;
	session: { id: string; title: string };
}

export interface ThreadBrief {
	known: string[];
	open: string[];
	recentFromMain: number;
}

export interface ThreadReport {
	sessionId: string;
	title: string;
	line: string;
}

export interface ThreadClose {
	writes: MemoryWrite[];
	report: ThreadReport;
}
