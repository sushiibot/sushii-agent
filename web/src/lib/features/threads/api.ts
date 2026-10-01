import { enc, featureHttp } from '$lib/core/feature-http';
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

const http = featureHttp("Threads aren't available yet.");

export const httpThreadsApi: ThreadsApi = {
	list: () => http.get('/chats'),
	get: (id) => http.find(`/threads/${enc(id)}`),
	branch: (from) => http.post('/threads', from),
	close: (id) => http.post(`/threads/${enc(id)}/close`),
	reopen: (id) => http.post(`/threads/${enc(id)}/reopen`)
};
