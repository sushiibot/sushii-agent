/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { ChatEnvelope } from '$lib/core/realtime/events';
import { createHub } from '$lib/core/realtime/hub.svelte';
import type { ChatTransport } from '$lib/core/realtime/transport';
import type { KeyValue } from '$lib/core/storage/outbox';
import type { ChatApi } from './api';
import { ChatStore } from './store.svelte';

const g = globalThis as unknown as { document?: unknown };
g.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

function memory<T>(): KeyValue<T> {
	return { all: async () => [], put: async () => {}, delete: async () => {} };
}

test('history merges after the hello that arrived with it, so first-frame asks keep their place', async () => {
	const hello: ChatEnvelope = {
		type: 'hello',
		data: {
			headSeq: 5,
			workspace: 'online',
			openTurns: [],
			pending: {
				approvals: [],
				asks: [{ seq: 3, at: 'x', key: 'k', askId: 'A', question: 'Which day?', choices: ['Fri'] }]
			}
		}
	};
	const transport: ChatTransport = {
		connect(_after, on, onState) {
			// One task, as one network chunk: the hub holds hello until its next frame.
			setTimeout(() => {
				onState('open');
				on(hello);
			}, 0);
			return () => {};
		}
	};
	const api = {
		history: async () => ({
			ok: true as const,
			page: {
				items: [
					{
						type: 'ask' as const,
						id: 'h1',
						at: 'x',
						outboxId: 'o',
						askId: 'A',
						question: 'Which day?',
						choices: ['Fri']
					}
				],
				before: null
			}
		})
	} as unknown as ChatApi;
	const store = new ChatStore('main', {
		hub: createHub({ transport }),
		api,
		outbox: memory(),
		drafts: memory()
	});
	await store.start();
	const asks = store.items.filter((i) => i.kind === 'ask');
	// Merged before hello, the page's own row would win and the first-frame ask would be dropped.
	expect(asks.map((i) => i.id)).toEqual(['pending:A']);
	expect(store.cursor).toBe(5);
	store.destroy();
});

test('a store created after the hub said hello still shows the approvals waiting then', async () => {
	const view = { tool: 'send_email', agentId: 'main', agentName: 'Main', fields: [] };
	const transport: ChatTransport = {
		connect(_after, on, onState) {
			setTimeout(() => {
				onState('open');
				on({
					type: 'hello',
					data: {
						headSeq: 5,
						workspace: 'online',
						openTurns: [],
						pending: { approvals: [{ seq: 4, at: 'x', nonce: 'n1', view }], asks: [] }
					}
				});
			}, 0);
			return () => {};
		}
	};
	const hub = createHub({ transport });
	hub.start();
	await Bun.sleep(40);
	const api = {
		history: async () => ({ ok: true as const, page: { items: [], before: null } })
	} as unknown as ChatApi;
	const store = new ChatStore('main', { hub, api, outbox: memory(), drafts: memory() });
	await store.start();
	expect(store.approvals.map((a) => a.nonce)).toEqual(['n1']);
	store.destroy();
});

/** A stream that greets at head 5, then sends a job alert at seq 6 when told to. */
function alertStream() {
	let push: (ev: ChatEnvelope) => void = () => {};
	const transport: ChatTransport = {
		connect(_after, on, onState) {
			push = on;
			setTimeout(() => {
				onState('open');
				on({
					type: 'hello',
					data: {
						headSeq: 5,
						workspace: 'online',
						openTurns: [],
						pending: { approvals: [], asks: [] }
					}
				});
			}, 0);
			return () => {};
		}
	};
	const alert = () =>
		push({
			type: 'alert',
			seq: 6,
			data: {
				key: 'o6',
				text: 'nightly-sync failed',
				alert: {
					source: 'job',
					job: 'nightly-sync',
					kind: 'failed',
					trigger: 'daily',
					startedAt: '2026-09-30T02:00:00.000Z',
					schedule: 'daily 02:00'
				}
			}
		});
	return { transport, alert };
}

async function alertStore(viewing: boolean) {
	const { transport, alert } = alertStream();
	const seen: number[] = [];
	const api = {
		history: async () => ({ ok: true as const, page: { items: [], before: null } }),
		seen: async (seq: number) => {
			seen.push(seq);
		}
	} as unknown as ChatApi;
	const store = new ChatStore('main', {
		hub: createHub({ transport }),
		api,
		outbox: memory(),
		drafts: memory()
	});
	await store.start();
	store.setViewing(viewing);
	alert();
	await Bun.sleep(1300);
	return { store, seen };
}

// A seen receipt suppresses the alert's push, so it may only cover an alert the chat drew on screen.
test('an alert that arrives while the chat is on screen is drawn before it counts as seen', async () => {
	const { store, seen } = await alertStore(true);
	expect(store.items.filter((i) => i.kind === 'alert')).toHaveLength(1);
	expect(store.messages.some((m) => m.parts.some((p) => p.type === 'data-alert'))).toBe(true);
	expect(seen).toEqual([6]);
	store.destroy();
});

test('an alert that arrives while the chat is off screen is never reported seen', async () => {
	const { store, seen } = await alertStore(false);
	expect(store.items.filter((i) => i.kind === 'alert')).toHaveLength(1);
	expect(seen).toEqual([]);
	store.destroy();
});
