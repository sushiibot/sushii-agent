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
}

export interface EmailDraft {
	from: string;
	to: string;
	subject: string;
	inReplyTo: { from: string; excerpt: string };
	body: string;
	changes?: DiffLine[];
}

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
