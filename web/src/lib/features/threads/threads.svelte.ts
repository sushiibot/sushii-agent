import { Remote } from '$lib/core/remote.svelte';
import { chatStore, type ChatStore } from '$lib/features/chat';
import { httpThreadsApi, type ThreadsApi } from './api';
import { readOnlyThreadChat, type ThreadChatDeps } from './thread-chat';
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
	#chatDeps: ThreadChatDeps;
	#threads = new Map<string, Remote<ThreadDetail | null>>();
	/** Messages can be sent in threads; false until the stream carries thread ids. */
	readonly canSend: boolean;

	constructor(api: ThreadsApi = httpThreadsApi, chatDeps: ThreadChatDeps = readOnlyThreadChat) {
		this.#api = api;
		this.#chatDeps = chatDeps;
		this.canSend = chatDeps !== readOnlyThreadChat;
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

	/** The thread's conversation, on its own store so it never touches Main's. */
	chat(detail: ThreadDetail): ChatStore {
		return chatStore(`thread:${detail.summary.id}`, this.#chatDeps(detail));
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
let configured: { api?: ThreadsApi; chat?: ThreadChatDeps } = {};

/** Swaps in another API and thread chat, for dev mode and tests; call before the first store. */
export function configureThreads(deps: { api?: ThreadsApi; chat?: ThreadChatDeps }) {
	configured = deps;
}

export function threadsStore(): ThreadsStore {
	return (store ??= new ThreadsStore(configured.api, configured.chat));
}
