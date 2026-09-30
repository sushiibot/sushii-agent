import { expect, test } from '@playwright/test';
import { CLIENT_ID_RE, type ChatEnvelope } from '../src/lib/chat/events';
import { fileRef, toMessages } from '../src/lib/chat/project';
import {
	addLocalSend,
	applyEvent,
	createState,
	mergeHistory,
	openTurns,
	type ChatState
} from '../src/lib/chat/reduce';
import { SseParser, toEnvelope } from '../src/lib/chat/sse';
import { ulid } from '../src/lib/chat/ulid';
import { fitWithin } from '../src/lib/chat/photo';

const run = (s: ChatState, evs: ChatEnvelope[]) => evs.flatMap((e) => applyEvent(s, e, 1000));
const texts = (s: ChatState) =>
	toMessages(s.items).flatMap((m) => m.parts.flatMap((p) => ('text' in p ? [p.text] : [])));

test('ulid matches the client id format and sorts by time', () => {
	const a = ulid(1_700_000_000_000);
	const b = ulid(1_700_000_000_001);
	expect(a).toMatch(CLIENT_ID_RE);
	expect(a < b).toBe(true);
});

test('the SSE parser handles split chunks, CRLF, comments and multi-line data', () => {
	const p = new SseParser();
	const frames = [
		...p.push(': hb\r\nevent: reply\r\nid: 7\r\ndata: {"a":'),
		...p.push('1,\r'),
		...p.push('\ndata: "b":2}\r\n\r\nevent: delta\ndata: {"x":1}\n\n')
	];
	expect(frames).toEqual([
		{ event: 'reply', id: '7', data: '{"a":1,\n"b":2}' },
		{ event: 'delta', id: undefined, data: '{"x":1}' }
	]);
	expect(toEnvelope(frames[0])).toEqual({ type: 'reply', seq: 7, data: { a: 1, b: 2 } });
	expect(toEnvelope({ event: 'x', data: 'not json' })).toBeNull();
});

test('durable replays at or below the cursor are ignored', () => {
	const s = createState();
	run(s, [
		{ type: 'hello', data: { headSeq: 10, workspace: 'online', openTurns: [] } },
		{ type: 'proactive', seq: 11, data: { key: 'p1', text: 'one', files: [] } },
		{ type: 'proactive', seq: 11, data: { key: 'p1', text: 'one', files: [] } },
		{ type: 'proactive', seq: 9, data: { key: 'p0', text: 'old', files: [] } }
	]);
	expect(texts(s)).toEqual(['one']);
	expect(s.cursor).toBe(11);
});

test('a reply with a turn id replaces the streamed text, and late deltas are dropped', () => {
	const s = createState();
	run(s, [
		{ type: 'delta', data: { turnId: 't', offset: 0, text: 'Hel' } },
		{ type: 'delta', data: { turnId: 't', offset: 3, text: 'lo' } },
		{ type: 'delta', data: { turnId: 't', offset: 1, text: 'zz' } },
		{ type: 'reply', seq: 1, data: { key: 'o', turnId: 't', text: 'Hello there.', files: [] } },
		{ type: 'delta', data: { turnId: 't', offset: 5, text: ' late' } }
	]);
	expect(texts(s)).toEqual(['Hello there.']);
	run(s, [
		{
			type: 'turn_final',
			seq: 2,
			data: { turnId: 't', outcome: 'done', summary: { durationMs: 12_000, toolCount: 0 } }
		}
	]);
	expect(openTurns(s)).toHaveLength(0);
});

test('a snapshot resyncs text after a gap, and tool events pair start with finish', () => {
	const s = createState();
	run(s, [
		{ type: 'delta', data: { turnId: 't', offset: 0, text: 'ab' } },
		{ type: 'delta', data: { turnId: 't', offset: 5, text: 'lost' } },
		{
			type: 'snapshot',
			data: {
				turnId: 't',
				view: { turnId: 't', startedAt: 0, lines: [], toolCount: 0, text: 'abcde' }
			}
		},
		{ type: 'delta', data: { turnId: 't', offset: 5, text: 'f' } },
		{ type: 'tool', data: { turnId: 't', name: 'read', summary: 'Reading' } },
		{ type: 'tool', data: { turnId: 't', name: 'read', summary: 'Read 3 files', ok: false } }
	]);
	expect(texts(s)).toEqual(['abcdef']);
	const turn = toMessages(s.items)[0].parts[0];
	expect(turn).toMatchObject({
		type: 'data-turn',
		data: { steps: [{ label: 'Read 3 files', state: 'failed' }] }
	});
});

test('status accepted marks the send delivered and shows a Working row', () => {
	const s = createState();
	addLocalSend(s, { clientId: 'C', text: 'hi', attachments: [], at: 'x', delivery: 'sending' });
	const fx = run(s, [
		{ type: 'user', seq: 1, data: { key: 'C', text: 'hi', uploadIds: [], at: 'x' } },
		{ type: 'status', seq: 2, data: { clientId: 'C', state: 'accepted' } }
	]);
	expect(fx).toContainEqual({ type: 'delivered', clientId: 'C' });
	const msgs = toMessages(s.items);
	expect(msgs).toHaveLength(2);
	expect(msgs[0]).toMatchObject({ role: 'user', delivery: 'sent' });
	expect(msgs[1].parts[0]).toMatchObject({ type: 'data-turn', data: { label: 'Working…' } });
	run(s, [{ type: 'tool', data: { turnId: 't', name: 'x', summary: 'Doing x' } }]);
	expect(toMessages(s.items)).toHaveLength(2);
});

test('history merges before local items and dedupes live events by key', () => {
	const s = createState();
	addLocalSend(s, { clientId: 'C', text: 'queued', attachments: [], at: 'z', delivery: 'queued' });
	mergeHistory(s, [
		{
			type: 'user',
			id: '1',
			clientId: 'C',
			at: 'z',
			text: 'queued',
			attachments: [],
			verified: true
		},
		{
			type: 'assistant',
			id: '2',
			outboxId: 'o1',
			at: 'y',
			text: 'answer',
			tools: [],
			files: [],
			verified: true
		},
		{
			type: 'approval',
			id: '3',
			at: 'y',
			nonce: 'n1',
			view: { tool: 'send_email', agentId: 'a', agentName: 'A', fields: [] },
			decision: null
		},
		{
			type: 'ask',
			id: '4',
			at: 'y',
			outboxId: 'o2',
			askId: 'k',
			question: 'q?',
			choices: ['a'],
			verified: false
		}
	]);
	run(s, [
		{ type: 'reply', seq: 1, data: { key: 'o1', text: 'answer', files: [] } },
		{
			type: 'approval',
			seq: 2,
			data: { nonce: 'n1', view: { tool: 'send_email', agentId: 'a', agentName: 'A', fields: [] } }
		}
	]);
	expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'approval', 'ask', 'user']);
	expect(s.approvals.map((a) => a.nonce)).toEqual(['n1']);
	expect(s.items[2]).toMatchObject({ kind: 'ask', state: 'history' });
	run(s, [{ type: 'approval_resolved', seq: 3, data: { nonce: 'n1', decision: 'approve' } }]);
	expect(s.approvals).toEqual([]);
	expect(s.items[1]).toMatchObject({ outcome: 'approved-elsewhere' });
});

test('an unknown approval decision reads as no longer needed, never as approved', () => {
	const s = createState();
	run(s, [
		{
			type: 'approval',
			seq: 1,
			data: { nonce: 'n', view: { tool: 't', agentId: 'a', agentName: 'A', fields: [] } }
		},
		{ type: 'approval_resolved', seq: 2, data: { nonce: 'n', decision: 'cancelled' as 'deny' } }
	]);
	expect(s.items[0]).toMatchObject({ outcome: 'cancelled' });
});

test('workspaceOffline queues pending sends; a reset keeps unsent messages only', () => {
	const s = createState();
	addLocalSend(s, { clientId: 'A', text: 'a', attachments: [], at: 'x', delivery: 'sending' });
	run(s, [
		{ type: 'proactive', seq: 1, data: { key: 'p', text: 'p', files: [] } },
		{ type: 'notice', seq: 2, data: { type: 'workspaceOffline' } }
	]);
	expect(s.items[0]).toMatchObject({ delivery: 'queued-agent' });
	expect(s.workspace).toBe('offline');
	const fx = run(s, [{ type: 'reset', data: { headSeq: 50 } }]);
	expect(fx).toContainEqual({ type: 'reload' });
	expect(s.items.map((i) => i.kind)).toEqual(['user']);
	expect(s.cursor).toBe(50);
});

test('file refs only become images for bot ids flagged inline', () => {
	expect(
		fileRef({
			id: 'AbCdEfGhIjKlMnOpQrStUv',
			contentType: 'image/png',
			bytes: 2048,
			name: 'a.png',
			inline: true
		})
	).toMatchObject({
		image: true,
		src: '/f/AbCdEfGhIjKlMnOpQrStUv',
		size: '2 KB'
	});
	expect(
		fileRef({
			id: 'AbCdEfGhIjKlMnOpQrStUv',
			contentType: 'text/html',
			bytes: 10,
			name: 'x.html',
			inline: false
		})
	).toMatchObject({
		image: false,
		src: undefined
	});
	expect(
		fileRef({ id: '../../etc/passwd', contentType: 'image/png', bytes: 1, name: 'p', inline: true })
	).toMatchObject({ removed: true, image: true });
	expect(
		fileRef({ id: '../../etc/passwd', contentType: 'image/png', bytes: 1, name: 'p', inline: true })
			.src
	).toBeUndefined();
	expect(fileRef(null, 'gone.jpg')).toMatchObject({ removed: true });
});

test('auth links render only for https URLs', () => {
	const s = createState();
	run(s, [
		{
			type: 'auth',
			seq: 1,
			data: { key: 'a', url: 'javascript:alert(1)', instructions: 'Log in:' }
		},
		{
			type: 'auth',
			seq: 2,
			data: { key: 'b', url: 'https://login.example/x', instructions: 'Log in:' }
		}
	]);
	const [bad, good] = toMessages(s.items).map((m) => JSON.stringify(m.parts));
	expect(bad).not.toContain('"kind":"link"');
	expect(good).toContain('"href":"https://login.example/x"');
});

test('photos fit a 2560 px long edge and never upscale', () => {
	expect(fitWithin(4032, 3024)).toEqual({ width: 2560, height: 1920 });
	expect(fitWithin(3024, 4032)).toEqual({ width: 1920, height: 2560 });
	expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
});
