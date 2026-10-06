import { HttpError, request } from '$lib/core/http';
import { OFFLINE_MAX_THREADS } from '$lib/core/storage/offline-cache';
import { offlineBrowsing } from '$lib/core/storage/offline.svelte';
import { enc, featureHttp } from '$lib/core/feature-http';
import type { ChatsData, ThreadDetail, ThreadSummary } from './types';

export interface ThreadsApi {
	/** Main, then every thread, archived ones included. */
	list(): Promise<ChatsData>;
	/** null: no thread with that id. */
	get(id: string): Promise<ThreadDetail | null>;
	/** Opens a thread from a Main message, with the selected reply as its brief. */
	branch(from: { messageId: string; title: string }): Promise<ThreadSummary>;
	/** Moves the thread into Archived while keeping its history resumable. */
	close(id: string): Promise<ThreadSummary>;
	reopen(id: string): Promise<ThreadSummary>;
	rename(id: string, title: string): Promise<ThreadSummary>;
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
	async list() {
		const data = await http.get<ChatsData>('/chats');
		if (!offlineBrowsing.unreachable) void warmThreads(data);
		return data;
	},
	get: (id) => http.find(`/threads/${enc(id)}`),
	branch: (from) => action('/threads', from),
	close: (id) => action(`/threads/${enc(id)}/close`),
	reopen: (id) => action(`/threads/${enc(id)}/reopen`),
	rename: (id, title) => action(`/threads/${enc(id)}/rename`, { title })
};

// Two workers keep the automatic offline download from flooding the gateway.
let warming = false;
const warmed = new Map<string, { activity: string; at: number }>();
async function warmThreads(data: ChatsData) {
	if (warming) return;
	warming = true;
	const recent = data.threads
		.filter((t) => t.state !== 'archived')
		.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
		.slice(0, OFFLINE_MAX_THREADS)
		.filter((t) => {
			const saved = warmed.get(t.id);
			return saved?.activity !== t.lastActivity || Date.now() - saved.at > 5 * 60_000;
		});
	try {
		await Promise.all(
			[0, 1].map(async () => {
				for (let thread = recent.shift(); thread; thread = recent.shift()) {
					if (typeof navigator !== 'undefined' && !navigator.onLine) break;
					try {
						const base = `/threads/${enc(thread.id)}`;
						await request('GET', base);
						await request('GET', `${base}/chat/history?limit=40`);
						if (offlineBrowsing.unreachable) break;
						warmed.set(thread.id, { activity: thread.lastActivity, at: Date.now() });
					} catch (err) {
						if (err instanceof HttpError && [0, 401, 403].includes(err.status)) break;
						// Retry on the next list refresh; browsing never waits for prefetch.
					}
				}
			})
		);
	} finally {
		warming = false;
	}
}
