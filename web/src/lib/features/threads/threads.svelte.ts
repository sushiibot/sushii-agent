import { Remote } from '$lib/core/remote.svelte';
import { createHub } from '$lib/core/realtime/hub.svelte';
import { memoryKeyValue, type Draft, type OutboxEntry } from '$lib/core/storage/outbox';
import { chatStore, createFakeBackend, type ChatStore } from '$lib/features/chat';
import type { ThreadsApi } from './api';
import { createFixtureThreadsApi } from './fake';
import type { ChatsData, ThreadDetail, ThreadReport } from './types';

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : 'Something went wrong. Try again.';

export class ThreadsStore {
	list: Remote<ChatsData>;
	/** Reports from threads closed since the app opened, for Main to show. */
	reports = $state.raw<ThreadReport[]>([]);
	busy = $state(false);
	error = $state<string | null>(null);

	#api: ThreadsApi;
	#threads = new Map<string, Remote<ThreadDetail | null>>();

	constructor(api: ThreadsApi = createFixtureThreadsApi()) {
		this.#api = api;
		this.list = new Remote(() => api.list(), { refetchOnFocus: true });
	}

	/** One thread's detail, kept for the app's life so back and forth doesn't reload it. */
	thread(id: string): Remote<ThreadDetail | null> {
		let remote = this.#threads.get(id);
		if (!remote) {
			remote = new Remote(() => this.#api.get(id));
			this.#threads.set(id, remote);
		}
		return remote;
	}

	/**
	 * The thread's conversation. Until the stream carries thread ids, each thread runs on its own
	 * in-memory bot seeded with the fixture history, and never touches Main's outbox or drafts.
	 */
	chat(detail: ThreadDetail): ChatStore {
		const fake = createFakeBackend({
			history: detail.history,
			reply: 'Noted. I kept this in the thread, and saved anything worth remembering.'
		});
		return chatStore(`thread:${detail.summary.id}`, {
			hub: createHub({ transport: fake.transport, carries: `thread:${detail.summary.id}` }),
			api: fake.api,
			outbox: memoryKeyValue<OutboxEntry>((e) => e.clientId),
			drafts: memoryKeyValue<Draft>((d) => d.id)
		});
	}

	async #act<T>(fn: () => Promise<T>): Promise<T | null> {
		this.busy = true;
		this.error = null;
		try {
			return await fn();
		} catch (err) {
			this.error = errorText(err);
			return null;
		} finally {
			this.busy = false;
		}
	}

	/** Starts a thread from a Main reply; resolves to its id, or null with `error` set. */
	async branch(messageId: string, title: string): Promise<string | null> {
		const t = await this.#act(() => this.#api.branch({ messageId, title }));
		if (!t) return null;
		void this.list.refetch();
		return t.id;
	}

	async close(id: string): Promise<boolean> {
		const report = await this.#act(() => this.#api.close(id));
		if (!report) return false;
		this.reports = [...this.reports, report];
		await Promise.all([this.list.refetch(), this.thread(id).refetch()]);
		return true;
	}

	async reopen(id: string): Promise<boolean> {
		const t = await this.#act(() => this.#api.reopen(id));
		if (!t) return false;
		await Promise.all([this.list.refetch(), this.thread(id).refetch()]);
		return true;
	}

	clearError() {
		this.error = null;
	}
}

let store: ThreadsStore | null = null;
let configured: ThreadsApi | undefined;

/** Swaps in another API, for tests; call before the first store. */
export function configureThreads(api: ThreadsApi) {
	configured = api;
}

export function threadsStore(): ThreadsStore {
	return (store ??= new ThreadsStore(configured));
}
