/// <reference types="bun" />
import { afterAll, expect, test } from 'bun:test';
import type { ChatEnvelope } from '$lib/core/realtime/events';
import { createHub } from '$lib/core/realtime/hub.svelte';
import type { ChatTransport } from '$lib/core/realtime/transport';
import type { KeyValue, OutboxEntry } from '$lib/core/storage/outbox';
import { memoryKeyValue } from '$lib/core/storage/outbox';
import type { ChatApi } from './api';
import { ChatStore } from './store.svelte';

const g = globalThis as unknown as { document?: unknown };
// Removed after this file: a leftover document makes later files' UI libraries assume window exists.
const stubbedDocument = g.document === undefined;
if (stubbedDocument)
	g.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
afterAll(() => {
	if (stubbedDocument) delete g.document;
});

function memory<T>(): KeyValue<T> {
	return { all: async () => [], put: async () => {}, delete: async () => {} };
}

const NONE = { approvals: [], asks: [] };

/** A stream that greets with a turn already running, and lets a test end that turn. */
function runningTurnStream() {
	let push: (ev: ChatEnvelope) => void = () => {};
	// A wrapper, so a test holds a live handle: `connect` assigns `push` after the test destructures.
	const send = (ev: ChatEnvelope) => push(ev);
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
						openTurns: [{ turnId: 't1', startedAt: 0, lines: [], toolCount: 0, text: '' }],
						pending: NONE
					}
				});
			}, 0);
			return () => {};
		}
	};
	return {
		transport,
		push: send,
		turnFinal: () =>
			send({
				type: 'turn_final',
				seq: 6,
				data: { turnId: 't1', outcome: 'done', summary: { durationMs: 10, toolCount: 0 } }
			})
	};
}

/** A history-ok API that records which client ids reached POST /api/chat/messages, and /steer. */
function recordingApi(posted: string[], steered: string[] = []) {
	return {
		history: async () => ({ ok: true as const, page: { items: [], before: null } }),
		postMessage: async (body: { clientId: string }) => {
			posted.push(body.clientId);
			return {};
		},
		steerMessage: async (clientId: string) => {
			steered.push(clientId);
			return { seq: 7, routed: false };
		}
	} as unknown as ChatApi;
}

const userText = (store: ChatStore, text: string) =>
	store.messages.find(
		(m) => m.role === 'user' && m.parts.some((p) => 'text' in p && p.text === text)
	);

test('a send while a turn runs posts at once, and the bot queuing it reads as queued-run', async () => {
	const { transport, push } = runningTurnStream();
	const posted: string[] = [];
	const outbox = memoryKeyValue<OutboxEntry>((e) => e.clientId);
	const store = new ChatStore('main', {
		hub: createHub({ transport }),
		api: recordingApi(posted),
		outbox,
		drafts: memory()
	});
	await store.start();
	expect(store.running).toBe(true);
	await store.send('held by the bot');
	// The device never decides: the POST goes out while the turn runs.
	await Bun.sleep(30);
	expect(posted).toHaveLength(1);
	const clientId = posted[0]!;
	expect(userText(store, 'held by the bot')?.delivery).toBe('sending');
	push({ type: 'status', seq: 7, data: { clientId, state: 'queued' } });
	await Bun.sleep(40);
	expect(userText(store, 'held by the bot')?.delivery).toBe('queued-run');
	// No receipt yet: no outbox entry leaves, and no Working row claims to work on it.
	expect(await outbox.all()).toHaveLength(1);
	expect(store.items.some((i) => i.id === 'turn:pending')).toBe(false);
	// The turn ends and the bot routes it: the accepted receipt settles it.
	push({ type: 'status', seq: 8, data: { clientId, state: 'accepted' } });
	await Bun.sleep(40);
	expect(userText(store, 'held by the bot')?.delivery).toBe('sent');
	expect(await outbox.all()).toEqual([]);
	store.destroy();
});

test('Send now calls the steer route, and the bot acks it as steered', async () => {
	const { transport, push } = runningTurnStream();
	const posted: string[] = [];
	const steered: string[] = [];
	const outbox = memoryKeyValue<OutboxEntry>((e) => e.clientId);
	const store = new ChatStore('main', {
		hub: createHub({ transport }),
		api: recordingApi(posted, steered),
		outbox,
		drafts: memory()
	});
	await store.start();
	await store.send('steer me');
	await Bun.sleep(30);
	expect(posted).toHaveLength(1);
	push({ type: 'status', seq: 7, data: { clientId: posted[0]!, state: 'queued' } });
	await Bun.sleep(40);
	const message = userText(store, 'steer me');
	expect(message?.delivery).toBe('queued-run');
	store.steerNow(message!.id);
	await Bun.sleep(30);
	// The steer goes to the route, not to a second POST of the message.
	expect(steered).toEqual(posted);
	expect(posted).toHaveLength(1);
	expect(store.running).toBe(true);
	push({ type: 'status', seq: 8, data: { clientId: posted[0]!, state: 'steer' } });
	await Bun.sleep(60);
	expect(userText(store, 'steer me')?.delivery).toBe('steered');
	// Settled: the bot holds it, so it leaves the outbox like a sent message.
	expect(await outbox.all()).toEqual([]);
	store.destroy();
});

test('a reload mid-queue keeps the message unsettled until the replayed queued ack arrives', async () => {
	const outbox = memoryKeyValue<OutboxEntry>((e) => e.clientId);
	await outbox.put({
		clientId: 'RELOADQUEUED000000000000',
		text: 'written mid-run',
		uploadIds: [],
		at: '2026-10-02T00:00:00.000Z',
		posted: true,
		attempted: true
	});
	const { transport, push } = runningTurnStream();
	const posted: string[] = [];
	const store = new ChatStore('main', {
		hub: createHub({ transport }),
		api: recordingApi(posted),
		outbox,
		drafts: memory()
	});
	await store.start();
	expect(store.running).toBe(true);
	await Bun.sleep(30);
	// A reload re-sends an entry the bot has not settled — harmless: it dedupes by clientId and
	// answers for the row it already holds — so the message waits on that receipt, not on the page.
	expect(userText(store, 'written mid-run')?.delivery).toBe('sending');
	// The bot's queued ack is durable, so the replay marks it what it is.
	push({ type: 'status', seq: 7, data: { clientId: 'RELOADQUEUED000000000000', state: 'queued' } });
	await Bun.sleep(40);
	expect(userText(store, 'written mid-run')?.delivery).toBe('queued-run');
	expect(await outbox.all()).toHaveLength(1);
	store.destroy();
});

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

test('a scoped topic receives pending approvals while a topic on Main does not', async () => {
	const view = { tool: 'send_email', agentId: 'main', agentName: 'Topic', fields: [] };
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
						pending: { approvals: [{ seq: 4, at: 'x', nonce: 'topic-nonce', view }], asks: [] }
					}
				});
			}, 0);
			return () => {};
		}
	};
	const api = {
		history: async () => ({ ok: true as const, page: { items: [], before: null } })
	} as unknown as ChatApi;
	const topic = new ChatStore('thread:trip', {
		hub: createHub({ transport, carries: 'thread:trip' }),
		approvals: true,
		api,
		outbox: memory(),
		drafts: memory()
	});
	const shared = new ChatStore('thread:other', {
		hub: createHub({ transport }),
		api,
		outbox: memory(),
		drafts: memory()
	});
	await Promise.all([topic.start(), shared.start()]);
	expect(topic.approvals.map((a) => a.nonce)).toEqual(['topic-nonce']);
	expect(shared.approvals).toEqual([]);
	topic.destroy();
	shared.destroy();
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

test('a confirmed decision removes pending controls without waiting for an SSE resolution', async () => {
	let send: ((event: ChatEnvelope) => void) | undefined;
	let resolveDecision!: (result: { status: 'decided' }) => void;
	let calls = 0;
	const hub = createHub({
		transport: {
			connect(_after, on, onState) {
				send = on;
				setTimeout(() => {
					onState('open');
					on({
						type: 'hello',
						data: {
							headSeq: 0,
							workspace: 'online',
							openTurns: [],
							pending: { approvals: [], asks: [] }
						}
					});
				}, 0);
				return () => {};
			}
		}
	});
	const store = new ChatStore('main', {
		hub,
		outbox: memory(),
		drafts: memory(),
		api: {
			history: async () => ({ ok: true, page: { items: [], before: null } }),
			decide: () => {
				calls++;
				return new Promise((resolve) => {
					resolveDecision = resolve;
				});
			}
		} as unknown as ChatApi
	});
	await store.start();
	send?.({
		type: 'approval',
		seq: 1,
		data: {
			nonce: 'n1',
			view: { tool: 'send_email', agentId: 'main', agentName: 'Main', fields: [] }
		}
	});
	await Bun.sleep(30);
	const first = store.decide('n1', 'approve');
	expect(store.trayPhase).toBe('submitting');
	await store.decide('n1', 'deny');
	expect(calls).toBe(1);
	resolveDecision({ status: 'decided' });
	await first;
	expect(store.approvals).toHaveLength(0);
	expect(store.trayPhase).toBe('ready');
	store.destroy();
});
