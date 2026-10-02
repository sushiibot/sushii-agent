import { hub } from '$lib/core/realtime/hub.svelte';
import { Remote } from '$lib/core/remote.svelte';
import { chatStore, type ChatStore } from '$lib/features/chat';
import { httpThreadsApi, type ThreadsApi } from './api';
import { liveThreadChat, readOnlyThreadChat, type ThreadChatDeps } from './thread-chat';
import type { ChatsData, ThreadDetail, ThreadReport } from './types';

const errorText = (err: unknown) =>
	err instanceof Error ? err.message : 'Something went wrong. Try again.';

export class ThreadsStore {
	list: Remote<ChatsData>;
	/** Legacy report compatibility; ordinary threads do not publish reports. */
	reports = $state.raw<ThreadReport[]>([]);
	busy = $state(false);
	error = $state<string | null>(null);

	#api: ThreadsApi;
	#chatDeps: ThreadChatDeps;
	#threads = new Map<string, Remote<ThreadDetail | null>>();
	/** Messages can be sent unless a read-only prototype adapter is supplied. */
	readonly canSend: boolean;

	constructor(api: ThreadsApi = httpThreadsApi, chatDeps: ThreadChatDeps = liveThreadChat) {
		this.#api = api;
		this.#chatDeps = chatDeps;
		this.canSend = chatDeps !== readOnlyThreadChat;
		this.list = new Remote(() => api.list(), { refetchOnFocus: true });
		if (chatDeps === liveThreadChat) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const changed = new Set<string>();
			hub.subscribe({ types: ['threads'] }, (batch) => {
				for (const ev of batch) if (ev.type === 'threads') changed.add(ev.data.id);
				if (!changed.size || timer) return;
				timer = setTimeout(() => {
					timer = undefined;
					if (this.list.status !== 'idle') void this.list.refetch();
					for (const id of changed) {
						const remote = this.#threads.get(id);
						if (remote) void remote.refetch();
					}
					changed.clear();
				}, 150);
			});
			hub.start();
		}
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
		const summary = await this.#act(() => this.#api.close(id));
		if (!summary) return false;
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
