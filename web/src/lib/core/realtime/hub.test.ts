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

	test('approvals are global, so a conversation subscriber still gets them', async () => {
		const { fake, hub } = setup();
		const main: (readonly ChatEnvelope[])[] = [];
		hub.subscribe({ conversation: 'main' }, (b) => main.push(b));
		hub.start();
		await tick();
		const view = { tool: 't', agentId: 'main', agentName: 'Main', fields: [] };
		fake.emit('approval', { nonce: 'n', view });
		fake.emit('approval_resolved', { nonce: 'n', decision: 'approve' });
		await tick();
		expect(types(main).at(-1)).toEqual(['approval', 'approval_resolved']);
		expect(conversationOf(main.at(-1)![0])).toBeNull();
		expect(conversationOf({ type: 'reply', data: { key: 'r', text: '', files: [] } })).toBe('main');
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
		hub.subscribe({}, (b) => batches.push(b));
		hub.stop();
		fake.emit('session', { kind: 'compacted' });
		await tick();
		expect(batches).toHaveLength(1);
	});
});
