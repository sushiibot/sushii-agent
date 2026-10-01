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

export interface DaySummary {
	date: string;
	summary: string;
	sessions: { id: string; title: string; time: string; messages: number }[];
	runs: { id: string; title: string; time: string; state: RunState; outcome: Outcome }[];
}

export type PushState = 'default' | 'granted' | 'denied' | 'unsupported';
