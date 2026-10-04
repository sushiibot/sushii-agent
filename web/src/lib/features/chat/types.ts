import type { SessionBoundary, UploadRef } from '$lib/core/realtime/events';

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
	| {
			type: 'data-tool';
			data: TurnStep & {
				approval?: { tool: string; outcome: ApprovalOutcome; nonce?: string };
				approvalReason?: string;
				confirmation?: AskView;
			};
	  }
	| { type: 'data-approval'; data: { tool: string; outcome: ApprovalOutcome; nonce?: string } }
	| { type: 'data-ask'; data: AskView }
	| { type: 'data-files'; data: { files: FileRef[]; dropped?: string } }
	| { type: 'data-divider'; data: SessionBoundary }
	| { type: 'data-history-gap' }
	| { type: 'data-line'; data: { text: string } }
	| { type: 'data-alert'; data: AlertLine }
	| {
			type: `tool-${string}`;
			toolCallId: string;
			state: ToolPartState;
			input: Record<string, string>;
			output?: Record<string, string>;
			approval?: { id: string; approved?: boolean };
	  };

/** A scheduled job's alert as a system line. Agent-controlled text: render it as plain text. */
export interface AlertLine {
	job: string;
	kind: 'failed' | 'stuck' | 'recovered';
	error?: string;
	/** Home's item for an open failure; only for a job name that passed JOB_NAME_RE. */
	href?: string;
}

export interface ChatMessage {
	turnId?: string;
	/** Stable server key used when branching from a reply. */
	sourceId?: string;
	id: string;
	role: 'user' | 'assistant';
	parts: MessagePart[];
	delivery?: Delivery;
	/** Still receiving deltas; the bubble reserves its height. */
	streaming?: boolean;
	/** The bot's files for this reply, as sent; the markdown renderer inlines only these. */
	uploads?: readonly UploadRef[];
}

export type Delivery =
	| 'sending'
	| 'sent'
	| 'failed'
	| 'queued'
	| 'queued-agent'
	/** The bot took the POST but queued it behind the running turn; it routes when that turn ends. */
	| 'queued-run'
	/** The bot queued it while a turn ran: steering joins the running turn. */
	| 'steered';

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

export interface ToolConfirmation {
	tool: string;
	input: string;
	reason?: string;
	toolCallId?: string;
}

export interface AskView {
	toolConfirmation?: ToolConfirmation;
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

export type ChatSheet = 'commands' | 'new' | 'viewer' | 'model';

export interface ChatTray {
	items: PendingApproval[];
	/** Leave unset to let the screen hold Approve for a moment whenever the tray moves. */
	armed?: boolean;
	state?: 'ready' | 'submitting' | 'timeout';
	details?: boolean;
	collapsed?: boolean;
}

export type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface VoiceModel {
	id: string;
	name: string;
	model: string;
	inputRate: number;
	audioInputUsd: number;
	audioOutputUsd: number;
	configured: boolean;
}
