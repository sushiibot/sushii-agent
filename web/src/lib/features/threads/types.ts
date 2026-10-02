// View models served by the bot's topic routes and the development fixtures.
import type { WebHistoryItem } from '$lib/core/realtime/events';
import type { MemoryWrite, ThreadReport } from '$lib/features/chat';

export type { MemoryWrite, ThreadReport };

/** What a thread needs from you, which groups it on the Chats list. */
export type ThreadState = 'needs-you' | 'running' | 'idle' | 'archived';

export interface ThreadSummary {
	id: string;
	title: string;
	state: ThreadState;
	/** ISO time of the newest message. */
	lastActivity: string;
	/** The newest message in one line, plain text. */
	preview: string;
	unread?: number;
	/** Memory writes made from this thread. */
	writes: number;
	/** False when the backend does not attribute individual memory edits. */
	memoryTracking?: boolean;
	/** Set once archived; `idle` when it archived itself. */
	archived?: { at: string; by: 'you' | 'idle' };
}

/** Main's row on the Chats list. */
export interface MainSummary {
	lastActivity: string;
	preview: string;
	unread?: number;
	state: Exclude<ThreadState, 'archived'>;
}

export interface ChatsData {
	main: MainSummary;
	threads: ThreadSummary[];
	/** Legacy server field; persistent threads have no active-count limit. */
	cap?: number;
	/** Idle days before a thread archives itself. */
	archiveAfterDays: number;
}

/** What Main handed the thread when it started. */
export interface ThreadBrief {
	known: string[];
	open: string[];
	/** Recent Main messages the thread also got; 0 means the brief only. */
	recentFromMain: number;
}

export interface ThreadDetail {
	summary: ThreadSummary;
	brief: ThreadBrief;
	/** Newest last. `after`: the history item the write followed. */
	writes: (MemoryWrite & { after?: string })[];
	/** The conversation as the bot's chat log would serve it. */
	history: WebHistoryItem[];
	/** Legacy report preview retained only by older fixtures or clients. */
	closing?: { writes: MemoryWrite[]; line: string };
}

/** The sheets a thread chat opens over itself. */
export type ThreadSheet = 'thread-memory' | 'thread-close' | 'thread-settings' | 'branch';
