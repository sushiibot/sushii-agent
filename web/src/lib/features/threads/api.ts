import type { ChatsData, ThreadDetail, ThreadReport, ThreadSummary } from './types';

export interface ThreadsApi {
	/** Main, then every thread, archived ones included. */
	list(): Promise<ChatsData>;
	/** null: no thread with that id. */
	get(id: string): Promise<ThreadDetail | null>;
	/** Opens a thread from a Main message, with a brief the agent writes. */
	branch(from: { messageId: string; title: string }): Promise<ThreadSummary>;
	/** Archives the thread and posts its one-line report to Main. */
	close(id: string): Promise<ThreadReport>;
	reopen(id: string): Promise<ThreadSummary>;
}
