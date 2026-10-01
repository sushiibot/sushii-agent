// A thread's conversation before the stream carries thread ids: its history comes from the
// thread's own record, nothing streams, and sending is refused, so it can never reach Main.
import { HttpError } from '$lib/core/http';
import type { ChatEnvelope } from '$lib/core/realtime/events';
import { createHub } from '$lib/core/realtime/hub.svelte';
import type { ChatTransport } from '$lib/core/realtime/transport';
import { memoryKeyValue, type Draft, type OutboxEntry } from '$lib/core/storage/outbox';
import type { ChatApi, ChatStoreDeps } from '$lib/features/chat';
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
