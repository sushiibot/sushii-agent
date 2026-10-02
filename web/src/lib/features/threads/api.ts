import { HttpError } from '$lib/core/http';
import { enc, featureHttp } from '$lib/core/feature-http';
import type { ChatsData, ThreadDetail, ThreadReport, ThreadSummary } from './types';

export interface ThreadsApi {
	/** Main, then every thread, archived ones included. */
	list(): Promise<ChatsData>;
	/** null: no thread with that id. */
	get(id: string): Promise<ThreadDetail | null>;
	/** Opens a thread from a Main message, with the selected reply as its brief. */
	branch(from: { messageId: string; title: string }): Promise<ThreadSummary>;
	/** Archives the thread and posts its one-line report to Main. */
	close(id: string): Promise<ThreadReport>;
	reopen(id: string): Promise<ThreadSummary>;
}

const http = featureHttp("Threads aren't available yet.");

async function action<T>(path: string, body?: unknown): Promise<T> {
	try {
		return await http.post<T>(path, body);
	} catch (err) {
		const said =
			err instanceof HttpError ? (err.body as { error?: unknown } | undefined)?.error : undefined;
		if (err instanceof HttpError && err.status === 409 && typeof said === 'string')
			throw new HttpError(409, said, err.body);
		throw err;
	}
}

export const httpThreadsApi: ThreadsApi = {
	list: () => http.get('/chats'),
	get: (id) => http.find(`/threads/${enc(id)}`),
	branch: (from) => action('/threads', from),
	close: (id) => action(`/threads/${enc(id)}/close`),
	reopen: (id) => action(`/threads/${enc(id)}/reopen`)
};
