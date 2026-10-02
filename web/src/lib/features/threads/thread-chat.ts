// Each live topic uses a scoped stream. Prototype fixtures can use a read-only adapter.
import { HttpError } from '$lib/core/http';
import type { ChatEnvelope } from '$lib/core/realtime/events';
import { createHub } from '$lib/core/realtime/hub.svelte';
import { fetchSse, type ChatTransport } from '$lib/core/realtime/transport';
import { memoryKeyValue, type Draft, type OutboxEntry } from '$lib/core/storage/outbox';
import { createHttpChatApi, type ChatApi, type ChatStoreDeps } from '$lib/features/chat';
import type { ThreadDetail } from './types';

const NOT_YET = "Threads can't take messages yet.";

const quietStream: ChatTransport = {
	connect(_after, on, onState) {
		const t = setTimeout(() => {
			onState('open');
			on({
				type: 'hello',
				data: {
					headSeq: 0,
					workspace: 'online',
					openTurns: [],
					pending: { approvals: [], asks: [] }
				}
			} as ChatEnvelope);
		}, 0);
		return () => clearTimeout(t);
	}
};

function readOnlyApi(detail: ThreadDetail): ChatApi {
	const refuse = async (): Promise<never> => {
		throw new HttpError(501, NOT_YET);
	};
	return {
		history: async () => ({ ok: true, page: { items: detail.history, before: null } }),
		postMessage: refuse,
		steerMessage: refuse,
		discardMessage: async () => 'unknown',
		stop: async () => {},
		command: refuse,
		answerAsk: refuse,
		decide: refuse,
		seen: async () => {},
		upload: refuse
	};
}

/** What a thread's chat runs on; dev mode swaps in a scripted bot that answers. */
export type ThreadChatDeps = (detail: ThreadDetail) => ChatStoreDeps;

export const readOnlyThreadChat: ThreadChatDeps = (detail) => ({
	hub: createHub({ transport: quietStream, carries: `thread:${detail.summary.id}` }),
	api: readOnlyApi(detail),
	outbox: memoryKeyValue<OutboxEntry>((e) => e.clientId),
	drafts: memoryKeyValue<Draft>((d) => d.id)
});

export const liveThreadChat: ThreadChatDeps = (detail) => {
	const base = `/threads/${encodeURIComponent(detail.summary.id)}/chat`;
	return {
		approvals: true,
		hub: createHub({
			transport: fetchSse({ url: `/api${base}/stream` }),
			carries: `thread:${detail.summary.id}`
		}),
		api: createHttpChatApi(base)
	};
};
