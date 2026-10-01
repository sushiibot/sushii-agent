/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { ChatEnvelope } from './events';
import { fakeTransport } from './fake-transport';
import { conversationOf, createHub } from './hub.svelte';

const tick = () => Bun.sleep(30);

function setup() {
	const fake = fakeTransport({ seq: 10 });
	let connects = 0;
	const transport = {
		connect: (...args: Parameters<typeof fake.transport.connect>) => {
			connects++;
			return fake.transport.connect(...args);
		}
	};
	const hub = createHub({ transport });
	return { fake, hub, connects: () => connects };
}

const approval = (nonce: string) => ({
	nonce,
	view: { tool: 't', agentId: 'main', agentName: 'Main', fields: [] }
});
const hello = (approvals: ReturnType<typeof approval>[], turns: string[] = []) => ({
	headSeq: 10,
	workspace: 'online' as const,
	openTurns: turns.map((turnId) => ({ turnId }) as never),
	pending: { approvals: approvals.map((a, i) => ({ ...a, seq: i + 1, at: 'x' })), asks: [] }
});

const types = (batches: (readonly ChatEnvelope[])[]) => batches.map((b) => b.map((e) => e.type));

describe('hub', () => {
	test('start opens one stream however often it is called', async () => {
		const { hub, connects } = setup();
		hub.start();
		hub.start();
		await tick();
		expect(connects()).toBe(1);
		expect(hub.connection).toBe('open');
		expect(hub.headSeq).toBe(10);
		expect(hub.workspace).toBe('online');
	});

	test('events that arrive together reach a subscriber as one batch, in order', async () => {
		const { fake, hub } = setup();
		const batches: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({}, (b) => batches.push(b));
		hub.start();
		await tick();
		fake.emit('user', { key: 'a', text: 'hi', uploadIds: [], at: 'x' });
		fake.emit('status', { clientId: 'a', state: 'accepted' });
		fake.emit('delta', { turnId: 't', offset: 0, text: 'Hel' }, false);
		expect(batches).toHaveLength(1);
		await tick();
		expect(types(batches)).toEqual([['hello'], ['user', 'status', 'delta']]);
		expect(hub.headSeq).toBe(12);
	});

	test('hello, reset and workspace reach every subscriber whatever its filter', async () => {
		const { fake, hub } = setup();
		const narrow: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({ conversation: 'main', types: ['reply'] }, (b) => narrow.push(b));
		hub.start();
		await tick();
		fake.emit('user', { key: 'a', text: 'hi', uploadIds: [], at: 'x' });
		fake.emit('workspace', { state: 'offline' }, false);
		fake.emit('reset', { headSeq: 40, workspace: 'offline', pending: { approvals: [], asks: [] } });
		fake.emit('reply', { key: 'r', text: 'ok', files: [] });
		await tick();
		expect(types(narrow)).toEqual([['hello'], ['workspace', 'reset', 'reply']]);
		expect(hub.workspace).toBe('offline');
	});

	test('approvals reach only subscribers that opt in, hello.pending included', async () => {
		const { fake, hub } = setup();
		const main: (readonly ChatEnvelope[])[] = [];
		const other: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({ conversation: 'main', globals: ['approval', 'approval_resolved'] }, (b) =>
			main.push(b)
		);
		hub.subscribe({ conversation: 'main' }, (b) => other.push(b));
		hub.start();
		await tick();
		fake.emit('hello', hello([approval('p1')]), false);
		fake.emit('approval', approval('n'));
		fake.emit('approval_resolved', { nonce: 'n', decision: 'approve' });
		fake.emit('reply', { key: 'r', text: 'ok', files: [] });
		await tick();
		expect(types(main).at(-1)).toEqual(['hello', 'approval', 'approval_resolved', 'reply']);
		expect(types(other).at(-1)).toEqual(['hello', 'reply']);
		const pending = (b: (readonly ChatEnvelope[])[]) =>
			b.flat().findLast((e) => e.type === 'hello')!.data as { pending: { approvals: unknown[] } };
		expect(pending(main).pending.approvals).toHaveLength(1);
		expect(pending(other).pending.approvals).toEqual([]);
		expect(conversationOf(main.at(-1)![1])).toBeNull();
		expect(conversationOf({ type: 'reply', data: { key: 'r', text: '', files: [] } })).toBe('main');
	});

	test("a thread's own stream carries that thread, never Main", async () => {
		const fake = fakeTransport({ seq: 1 });
		const hub = createHub({ transport: fake.transport, carries: 'thread:trip' });
		const thread: (readonly ChatEnvelope[])[] = [];
		const main: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({ conversation: 'thread:trip' }, (b) => thread.push(b));
		hub.subscribe({ conversation: 'main' }, (b) => main.push(b));
		hub.start();
		await tick();
		fake.emit('reply', { key: 'r', text: 'ok', files: [] });
		await tick();
		expect(types(thread).flat()).toEqual(['hello', 'reply']);
		expect(types(main).flat()).toEqual(['hello']);
	});

	test('a subscriber that joins after hello gets it replayed with what changed since', async () => {
		const { fake, hub } = setup();
		hub.start();
		await tick();
		fake.emit('hello', hello([approval('p1'), approval('p2')], ['t1']), false);
		fake.emit('approval_resolved', { nonce: 'p1', decision: 'deny' });
		fake.emit('approval', approval('n1'));
		fake.emit('approval', approval('gone'));
		fake.emit('approval_resolved', { nonce: 'gone', decision: 'approve' });
		fake.emit('workspace', { state: 'offline' }, false);
		fake.emit('workspace', { state: 'online' }, false);
		fake.emit('reply', { key: 'r', text: 'missed', files: [] });
		fake.emit('turn_final', { turnId: 't1', outcome: 'done', summary: null });
		await tick();

		const late: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({ conversation: 'main', globals: ['approval', 'approval_resolved'] }, (b) =>
			late.push(b)
		);
		await Promise.resolve();
		expect(types(late)).toEqual([
			['hello', 'approval_resolved', 'approval', 'workspace', 'turn_final']
		]);
		expect(late[0][2].data).toMatchObject({ nonce: 'n1' });
		expect(late[0][3].data).toEqual({ state: 'online' });

		const plain: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({ conversation: 'main' }, (b) => plain.push(b));
		await Promise.resolve();
		expect(types(plain)).toEqual([['hello', 'workspace', 'turn_final']]);
		expect((plain[0][0].data as { pending: { approvals: unknown[] } }).pending.approvals).toEqual(
			[]
		);
	});

	test('stop forgets the connection, so nothing stale replays or reports', async () => {
		const { hub } = setup();
		hub.start();
		await tick();
		hub.stop();
		expect(hub.connection).toBe('connecting');
		expect(hub.headSeq).toBeNull();
		expect(hub.workspace).toBeNull();
		const heard: string[] = [];
		hub.onState((s) => heard.push(s));
		const batches: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({}, (b) => batches.push(b));
		await tick();
		expect(heard).toEqual([]);
		expect(batches).toEqual([]);
	});

	test('flush delivers what is queued at once', async () => {
		const { fake, hub } = setup();
		const batches: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({}, (b) => batches.push(b));
		hub.start();
		await tick();
		fake.emit('session', { kind: 'new' });
		hub.flush();
		expect(types(batches)).toEqual([['hello'], ['session']]);
		await tick();
		expect(batches).toHaveLength(2);
	});

	test('state watchers hear every change, and the current state when they join', async () => {
		const { fake, hub } = setup();
		const early: string[] = [];
		hub.onState((s) => early.push(s));
		hub.start();
		await tick();
		fake.setState('reconnecting');
		expect(hub.reconnectingSince).not.toBeNull();
		const late: string[] = [];
		hub.onState((s) => late.push(s));
		fake.setState('open');
		expect(hub.reconnectingSince).toBeNull();
		expect(early).toEqual(['open', 'reconnecting', 'open']);
		expect(late).toEqual(['reconnecting', 'open']);
	});

	test('an unsubscribed or stopped hub delivers nothing more', async () => {
		const { fake, hub } = setup();
		const batches: (readonly ChatEnvelope[])[] = [];
		const off = hub.subscribe({}, (b) => batches.push(b));
		hub.start();
		await tick();
		off();
		fake.emit('session', { kind: 'new' });
		await tick();
		expect(batches).toHaveLength(1);
		hub.stop();
		hub.subscribe({}, (b) => batches.push(b));
		fake.emit('session', { kind: 'compacted' });
		await tick();
		expect(batches).toHaveLength(1);
	});
});
