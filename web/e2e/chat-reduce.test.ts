import { expect, test } from '@playwright/test';
import { CLIENT_ID_RE, type ChatEnvelope } from '../src/lib/core/realtime/events';
import { fileRef, toMessages } from '../src/lib/features/chat/project';
import {
	addLocalSend,
	applyEvent,
	createState,
	dropApproval,
	mergeHistory,
	openTurns,
	PENDING_TURN_ID,
	restartHistory,
	type ChatState
} from '../src/lib/features/chat/reduce';
import { SseParser, toEnvelope } from '../src/lib/core/realtime/sse';
import { ulid } from '../src/lib/core/storage/ulid';
import { fitWithin } from '../src/lib/features/chat/photo';

const NONE = { approvals: [], asks: [] };
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
		{ type: 'hello', data: { headSeq: 10, workspace: 'online', openTurns: [], pending: NONE } },
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

test('after a steer splits the turn, the new turn is working from its empty snapshot, before any output', () => {
	const s = createState();
	const view = (turnId: string) => ({ turnId, startedAt: 0, lines: [], toolCount: 0, text: '' });
	run(s, [
		{ type: 'snapshot', data: { turnId: 't1', view: view('t1') } },
		{ type: 'delta', data: { turnId: 't1', offset: 0, text: 'first answer' } },
		{ type: 'turn_final', seq: 1, data: { turnId: 't1', outcome: 'done', summary: null } },
		{ type: 'reply', seq: 2, data: { key: 'o1', turnId: 't1', text: 'first answer', files: [] } }
	]);
	expect(openTurns(s)).toHaveLength(0);
	run(s, [{ type: 'snapshot', data: { turnId: 't2', view: view('t2') } }]);
	expect(openTurns(s).map((t) => t.turnId)).toEqual(['t2']);
	expect(texts(s)).toEqual(['first answer']);
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
	const turn = toMessages(s.items)[0].parts.find((part) => part.type === 'data-tool');
	expect(turn).toMatchObject({
		type: 'data-tool',
		data: { label: 'Read 3 files', state: 'failed' }
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
	expect(msgs[1].parts[0]).toMatchObject({ type: 'data-turn', data: { label: 'Thinking…' } });
	run(s, [{ type: 'tool', data: { turnId: 't', name: 'x', summary: 'Doing x' } }]);
	expect(toMessages(s.items)).toHaveLength(2);
});

const labels = (s: ChatState) =>
	toMessages(s.items).flatMap((m) =>
		m.parts.flatMap((p) => (p.type === 'data-turn' && p.data.label ? [p.data.label] : []))
	);

test('status steer settles the send as steered, without claiming a new turn', () => {
	const s = createState();
	addLocalSend(s, {
		clientId: 'C',
		text: 'steer me',
		attachments: [],
		at: 'x',
		delivery: 'queued-run'
	});
	const fx = run(s, [{ type: 'status', seq: 1, data: { clientId: 'C', state: 'steer' } }]);
	// Delivered, but no Working row: the send joined the turn that was already running.
	expect(fx).toContainEqual({ type: 'delivered', clientId: 'C' });
	expect(fx).not.toContainEqual({ type: 'turnEnd' });
	expect(s.items.some((i) => i.id === PENDING_TURN_ID)).toBe(false);
	expect(toMessages(s.items)[0]).toMatchObject({ role: 'user', delivery: 'steered' });
	// Restarting history drops it like any settled send: the bot carries it back.
	restartHistory(s);
	expect(toMessages(s.items).some((m) => m.role === 'user')).toBe(false);
});

test('a reply with no progress before it takes the Working slot, and the turn ends', () => {
	const s = createState();
	addLocalSend(s, { clientId: 'A', text: 'first', attachments: [], at: 'x', delivery: 'sending' });
	run(s, [
		{ type: 'status', seq: 1, data: { clientId: 'A', state: 'accepted' } },
		{ type: 'reply', seq: 2, data: { key: 'o1', turnId: 't1', text: 'Done.', files: [] } },
		{
			type: 'turn_final',
			seq: 3,
			data: { turnId: 't1', outcome: 'done', summary: { durationMs: 900, toolCount: 0 } }
		}
	]);
	expect(openTurns(s)).toHaveLength(0);
	expect(s.items.some((i) => i.id === PENDING_TURN_ID)).toBe(false);
	expect(labels(s)).not.toContain('Thinking…');
	expect(texts(s)).toEqual(['first', 'Done.']);

	addLocalSend(s, { clientId: 'B', text: 'second', attachments: [], at: 'y', delivery: 'sending' });
	run(s, [
		{ type: 'status', seq: 4, data: { clientId: 'B', state: 'accepted' } },
		{ type: 'delta', data: { turnId: 't2', offset: 0, text: 'Streaming' } }
	]);
	expect(texts(s)).toEqual(['first', 'Done.', 'second', 'Streaming']);
	expect(openTurns(s).map((t) => t.turnId)).toEqual(['t2']);
});

test('after backgrounding, a replay of only durable events leaves no turn running', () => {
	const s = createState();
	run(s, [
		{ type: 'hello', data: { headSeq: 0, workspace: 'online', openTurns: [], pending: NONE } }
	]);
	addLocalSend(s, { clientId: 'A', text: 'hi', attachments: [], at: 'x', delivery: 'sending' });
	run(s, [
		{ type: 'user', seq: 1, data: { key: 'A', text: 'hi', uploadIds: [], at: 'x' } },
		{ type: 'status', seq: 2, data: { clientId: 'A', state: 'accepted' } }
	]);
	expect(openTurns(s)).toHaveLength(1);
	// The stream closed on hidden; the resume replays only what was stored meanwhile.
	run(s, [
		{ type: 'hello', data: { headSeq: 5, workspace: 'online', openTurns: [], pending: NONE } },
		{ type: 'reply', seq: 3, data: { key: 'o', turnId: 't', text: 'Hello.', files: [] } },
		{
			type: 'turn_final',
			seq: 4,
			data: { turnId: 't', outcome: 'interrupted', summary: null }
		},
		{
			type: 'turn_final',
			seq: 5,
			data: { turnId: 't', outcome: 'done', summary: { durationMs: 3000, toolCount: 0 } }
		}
	]);
	expect(openTurns(s)).toHaveLength(0);
	expect(labels(s)).toEqual([]);
	expect(texts(s)).toEqual(['hi', 'Hello.']);
	expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', turn: { phase: 'done' } });
	expect(s.cursor).toBe(5);
});

test('a cursor resume applies replayed events at or below the new head', () => {
	const s = createState();
	run(s, [
		{ type: 'hello', data: { headSeq: 10, workspace: 'online', openTurns: [], pending: NONE } },
		{ type: 'hello', data: { headSeq: 20, workspace: 'online', openTurns: [], pending: NONE } },
		...Array.from({ length: 10 }, (_, i) => ({
			type: 'proactive' as const,
			seq: 11 + i,
			data: { key: `p${i}`, text: `n${i}`, files: [] }
		}))
	]);
	expect(texts(s)).toHaveLength(10);
	expect(s.cursor).toBe(20);
});

test('a second reply for the same turn shows as its own bubble', () => {
	const s = createState();
	run(s, [
		{ type: 'delta', data: { turnId: 't', offset: 0, text: 'a' } },
		{ type: 'reply', seq: 1, data: { key: 'o1', turnId: 't', text: 'First.', files: [] } },
		{ type: 'reply', seq: 2, data: { key: 'o2', turnId: 't', text: 'Failed: x', files: [] } }
	]);
	expect(texts(s)).toEqual(['First.', 'Failed: x']);
});

test('a restored send that history already holds settles in its history position', () => {
	const s = createState();
	addLocalSend(s, { clientId: 'C', text: 'hi', attachments: [], at: 'z', delivery: 'sending' });
	const fx = mergeHistory(s, [
		{ type: 'user', id: '1', clientId: 'C', at: 'z', text: 'hi', attachments: [] },
		{
			type: 'assistant',
			id: '2',
			outboxId: 'o1',
			at: 'z',
			text: 'reply',
			tools: [],
			files: []
		}
	]);
	expect(fx).toEqual([{ type: 'delivered', clientId: 'C' }]);
	expect(texts(s)).toEqual(['hi', 'reply']);
	expect(s.items[0]).toMatchObject({ kind: 'user', clientId: 'C', delivery: 'sent' });
	expect(s.items).toHaveLength(2);
});

test('a notice naming a client id settles that send, or queues it when the agent is offline', () => {
	const s = createState();
	addLocalSend(s, { clientId: 'A', text: 'a', attachments: [], at: 'x', delivery: 'sending' });
	addLocalSend(s, { clientId: 'B', text: 'b', attachments: [], at: 'x', delivery: 'queued' });
	const fx = run(s, [
		{ type: 'notice', seq: 1, data: { type: 'commandOffline', clientId: 'A' } },
		{ type: 'notice', seq: 2, data: { type: 'workspaceOffline', clientId: 'B' } }
	]);
	expect(fx).toContainEqual({ type: 'delivered', clientId: 'A' });
	expect(fx).not.toContainEqual({ type: 'delivered', clientId: 'B' });
	expect(s.items[0]).toMatchObject({ delivery: 'sent' });
	expect(s.items[1]).toMatchObject({ delivery: 'queued-agent' });
});

test('a cancelled approval from history reads as cancelled, not timed out', () => {
	const s = createState();
	mergeHistory(s, [
		{
			type: 'approval',
			id: '1',
			at: 'x',
			nonce: 'n',
			view: { tool: 't', agentId: 'a', agentName: 'A', fields: [] },
			decision: 'cancelled'
		}
	]);
	expect(s.items[0]).toMatchObject({ outcome: 'cancelled' });
	dropApproval(s, 'x', 'timeout');
	expect(s.items[0]).toMatchObject({ outcome: 'cancelled' });
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
			attachments: []
		},
		{
			type: 'assistant',
			id: '2',
			outboxId: 'o1',
			at: 'y',
			text: 'answer',
			tools: [],
			files: []
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
			answer: 'a'
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
	expect(s.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'approval', 'ask']);
	expect(s.approvals.map((a) => a.nonce)).toEqual(['n1']);
	expect(s.items[3]).toMatchObject({ kind: 'ask', state: 'history' });
	run(s, [{ type: 'approval_resolved', seq: 3, data: { nonce: 'n1', decision: 'approve' } }]);
	expect(s.approvals).toEqual([]);
	expect(s.items[2]).toMatchObject({ outcome: 'approved-elsewhere' });
});

test('an unknown approval decision reads as no longer needed, never as approved', () => {
	const s = createState();
	run(s, [
		{
			type: 'approval',
			seq: 1,
			data: { nonce: 'n', view: { tool: 't', agentId: 'a', agentName: 'A', fields: [] } }
		},
		{ type: 'approval_resolved', seq: 2, data: { nonce: 'n', decision: 'cancelled' } }
	]);
	expect(s.items[0]).toMatchObject({ outcome: 'cancelled' });
});

test('workspaceOffline queues pending sends; a reset keeps unsent messages only', () => {
	const s = createState();
	run(s, [
		{ type: 'hello', data: { headSeq: 0, workspace: 'online', openTurns: [], pending: NONE } }
	]);
	addLocalSend(s, { clientId: 'A', text: 'a', attachments: [], at: 'x', delivery: 'sending' });
	const noticed = run(s, [
		{ type: 'proactive', seq: 1, data: { key: 'p', text: 'p', files: [] } },
		{ type: 'notice', seq: 2, data: { type: 'workspaceOffline' } }
	]);
	expect(s.items[0]).toMatchObject({ kind: 'user', delivery: 'queued-agent' });
	// Only first frames and workspace events set the workspace state.
	expect(s.workspace).toBe('online');
	expect(noticed).not.toContainEqual(expect.objectContaining({ type: 'workspace' }));
	const fx = run(s, [
		{ type: 'reset', data: { headSeq: 50, workspace: 'offline', pending: NONE } }
	]);
	expect(fx).toContainEqual({ type: 'reload' });
	expect(fx).toContainEqual({ type: 'workspace', state: 'offline' });
	expect(s.workspace).toBe('offline');
	expect(s.items.map((i) => i.kind)).toEqual(['user']);
	expect(s.cursor).toBe(50);
});

test('every first frame that says online asks for a resend, even with no change', () => {
	const s = createState();
	const hello = (workspace: 'online' | 'offline') =>
		run(s, [{ type: 'hello', data: { headSeq: 0, workspace, openTurns: [], pending: NONE } }]);
	expect(hello('online')).toEqual([{ type: 'workspace', state: 'online' }, { type: 'resend' }]);
	expect(hello('online')).toEqual([{ type: 'resend' }]);
	expect(hello('offline')).toEqual([{ type: 'workspace', state: 'offline' }]);
});

test('a refused message fails visibly with the reason and is not settled', () => {
	const s = createState();
	run(s, [
		{ type: 'hello', data: { headSeq: 0, workspace: 'online', openTurns: [], pending: NONE } }
	]);
	addLocalSend(s, { clientId: 'A', text: 'a', attachments: [], at: 'x', delivery: 'sending' });
	const fx = run(s, [
		{
			type: 'notice',
			seq: 1,
			data: { type: 'messageRejected', error: 'model auth failed', clientId: 'A' }
		}
	]);
	expect(fx).toEqual([{ type: 'failed', clientId: 'A' }]);
	expect(s.items[0]).toMatchObject({ kind: 'user', delivery: 'failed' });
	expect(s.workspace).toBe('online');
	expect(s.items).toContainEqual(
		expect.objectContaining({
			kind: 'line',
			text: "Your message didn't reach the agent: model auth failed"
		})
	);
});

test('an ask resolved with no answer, live or from history, is no longer answerable', () => {
	const s = createState();
	run(s, [
		{
			type: 'ask',
			seq: 1,
			data: { key: 'o1', askId: 'k1', question: 'When?', choices: ['Sat'] }
		},
		{ type: 'ask_resolved', seq: 2, data: { askId: 'k1', answer: null } }
	]);
	expect(s.items[0]).toMatchObject({ kind: 'ask', state: 'history', answer: undefined });
	const h = createState();
	mergeHistory(h, [
		{
			type: 'ask',
			id: 'a',
			at: 'x',
			outboxId: 'o2',
			askId: 'k2',
			question: 'Where?',
			choices: ['Home'],
			answer: null
		}
	]);
	expect(h.items[0]).toMatchObject({ kind: 'ask', state: 'history', answer: undefined });
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
	const [bad, good] = toMessages(s.items).map((m) => m.parts[0]);
	expect(bad).toMatchObject({ type: 'data-auth', data: { https: false } });
	expect(good).toMatchObject({
		type: 'data-auth',
		data: { https: true, url: 'https://login.example/x' }
	});
});

test('photos fit a 2560 px long edge and never upscale', () => {
	expect(fitWithin(4032, 3024)).toEqual({ width: 2560, height: 1920 });
	expect(fitWithin(3024, 4032)).toEqual({ width: 1920, height: 2560 });
	expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
});

const view = (tool: string) => ({ tool, agentId: 'a', agentName: 'A', fields: [] });
const pendingApproval = (nonce: string) => ({ seq: 1, at: 'x', nonce, view: view('send_email') });
const pendingAsk = (askId: string) => ({
	seq: 2,
	at: 'x',
	key: `o-${askId}`,
	askId,
	question: `Which ${askId}?`,
	choices: ['A', 'B']
});

test('hello seeds the tray and ask cards from the bot log, and history does not duplicate them', () => {
	const s = createState();
	run(s, [
		{
			type: 'hello',
			data: {
				headSeq: 5,
				workspace: 'online',
				openTurns: [],
				pending: { approvals: [pendingApproval('n1')], asks: [pendingAsk('k1')] }
			}
		}
	]);
	expect(s.approvals.map((a) => a.nonce)).toEqual(['n1']);
	expect(s.items).toMatchObject([
		{ kind: 'approval', nonce: 'n1', outcome: 'pending' },
		{ kind: 'ask', askId: 'k1', state: 'pending' }
	]);

	mergeHistory(s, [
		{ type: 'user', id: 'u1', at: 'x', text: 'first', attachments: [] },
		{
			type: 'ask',
			id: 'q1',
			at: 'x',
			outboxId: 'o-k1',
			askId: 'k1',
			question: 'Which k1?',
			choices: ['A', 'B']
		},
		{
			type: 'approval',
			id: 'p1',
			at: 'x',
			nonce: 'n1',
			view: view('send_email'),
			decision: null
		},
		{ type: 'user', id: 'u2', at: 'x', text: 'later', attachments: [] }
	]);
	expect(s.items.map((i) => i.kind)).toEqual(['user', 'ask', 'approval', 'user']);
	expect(s.approvals).toHaveLength(1);

	run(s, [
		{ type: 'ask', seq: 6, data: { key: 'o-k1', askId: 'k1', question: 'Which k1?', choices: [] } },
		{ type: 'approval', seq: 7, data: { nonce: 'n1', view: view('send_email') } }
	]);
	expect(s.items.filter((i) => i.kind === 'ask')).toHaveLength(1);
	expect(s.approvals).toHaveLength(1);
});

test('a reset leaves only the approvals the bot still has in the tray', () => {
	const s = createState();
	run(s, [
		{
			type: 'hello',
			data: {
				headSeq: 5,
				workspace: 'online',
				openTurns: [],
				pending: { approvals: [pendingApproval('n1'), pendingApproval('n2')], asks: [] }
			}
		}
	]);
	expect(s.approvals.map((a) => a.nonce)).toEqual(['n1', 'n2']);
	run(s, [
		{
			type: 'reset',
			data: {
				headSeq: 90,
				workspace: 'online',
				pending: { approvals: [pendingApproval('n2')], asks: [pendingAsk('k2')] }
			}
		}
	]);
	expect(s.approvals.map((a) => a.nonce)).toEqual(['n2']);
	expect(s.items).toMatchObject([
		{ kind: 'approval', nonce: 'n2', outcome: 'pending' },
		{ kind: 'ask', askId: 'k2', state: 'pending' }
	]);
});

test('a hello on resume drops a tray approval the bot no longer lists', () => {
	const s = createState();
	run(s, [
		{ type: 'hello', data: { headSeq: 0, workspace: 'online', openTurns: [], pending: NONE } },
		{ type: 'approval', seq: 1, data: { nonce: 'n1', view: view('send_email') } }
	]);
	expect(s.approvals).toHaveLength(1);
	run(s, [
		{ type: 'hello', data: { headSeq: 3, workspace: 'online', openTurns: [], pending: NONE } }
	]);
	expect(s.approvals).toHaveLength(0);
	expect(s.items).toMatchObject([{ kind: 'approval', nonce: 'n1', outcome: 'timeout' }]);
	run(s, [{ type: 'approval_resolved', seq: 2, data: { nonce: 'n1', decision: 'approve' } }]);
	expect(s.items).toMatchObject([{ kind: 'approval', outcome: 'approved-elsewhere' }]);
});

test('a stale history cursor restarts history but keeps the tray and the cursor', () => {
	const s = createState();
	run(s, [
		{ type: 'hello', data: { headSeq: 0, workspace: 'online', openTurns: [], pending: NONE } },
		{ type: 'approval', seq: 4, data: { nonce: 'n1', view: view('send_email') } }
	]);
	expect(restartHistory(s)).toEqual([{ type: 'reload' }]);
	expect(s.items).toEqual([]);
	expect(s.approvals.map((a) => a.nonce)).toEqual(['n1']);
	expect(s.cursor).toBe(4);
});

test('an undecided history approval the first frame did not list draws its marker but stays off the tray', () => {
	const s = createState();
	run(s, [
		{
			type: 'hello',
			data: {
				headSeq: 5,
				workspace: 'online',
				openTurns: [],
				pending: { approvals: [pendingApproval('n2')], asks: [] }
			}
		}
	]);
	mergeHistory(s, [
		{ type: 'approval', id: 'p1', at: 'x', nonce: 'n1', view: view('bash'), decision: null },
		{ type: 'approval', id: 'p2', at: 'x', nonce: 'n2', view: view('send_email'), decision: null }
	]);
	expect(s.approvals.map((a) => a.nonce)).toEqual(['n2']);
	expect(s.items.filter((i) => i.kind === 'approval').map((i) => i.id)).toEqual(['h:p1', 'h:p2']);
});

test('a stale history cursor keeps the asks the first frame seeded', () => {
	const s = createState();
	run(s, [
		{
			type: 'hello',
			data: {
				headSeq: 5,
				workspace: 'online',
				openTurns: [],
				pending: { approvals: [], asks: [pendingAsk('k1')] }
			}
		}
	]);
	restartHistory(s);
	expect(s.items).toMatchObject([{ kind: 'ask', askId: 'k1', state: 'pending' }]);
	mergeHistory(s, []);
	run(s, [{ type: 'ask', seq: 6, data: { key: 'o-k1', askId: 'k1', question: 'q', choices: [] } }]);
	expect(s.items.filter((i) => i.kind === 'ask')).toHaveLength(1);
});

test('a job alert shows once as a system line, live or from history, and alert_cleared adds nothing', () => {
	const alert = {
		source: 'job' as const,
		job: 'nightly-sync',
		kind: 'failed' as const,
		trigger: 'daily' as const,
		startedAt: '2026-09-30T02:00:00.000Z',
		error: 'exit 1: <b>boom</b>',
		schedule: 'daily 02:00'
	};
	const s = createState();
	run(s, [
		{ type: 'alert', seq: 1, data: { key: 'o1', alert, text: 'nightly-sync failed' } },
		{ type: 'alert_cleared', seq: 2, data: { id: 'job:nightly-sync', reason: 'dismissed' } }
	]);
	mergeHistory(s, [
		{ type: 'alert', id: '7', at: 'x', outboxId: 'o1', alert, text: 'nightly-sync failed' },
		{
			type: 'alert',
			id: '9',
			at: 'y',
			outboxId: 'o2',
			alert: { ...alert, kind: 'recovered', error: undefined },
			text: 'nightly-sync recovered'
		}
	]);
	run(s, [
		{
			type: 'alert',
			seq: 3,
			data: { key: 'o2', alert: { ...alert, kind: 'recovered' }, text: 'nightly-sync recovered' }
		}
	]);
	const lines = toMessages(s.items).flatMap((m) =>
		m.parts.flatMap((p) => (p.type === 'data-alert' ? [p.data] : []))
	);
	expect(lines).toEqual([
		{ job: 'nightly-sync', kind: 'recovered' },
		{
			job: 'nightly-sync',
			kind: 'failed',
			error: 'exit 1: <b>boom</b>',
			href: '/?item=job%3Anightly-sync'
		}
	]);
});

test("an alert's Details link is left out unless the job name is a plain job name", () => {
	const s = createState();
	const alert = {
		source: 'job' as const,
		job: 'x/../../f',
		kind: 'stuck' as const,
		trigger: 'manual' as const,
		startedAt: '2026-09-30T02:00:00.000Z',
		schedule: 'manual'
	};
	run(s, [{ type: 'alert', seq: 1, data: { key: 'o9', alert, text: 't' } }]);
	const [line] = toMessages(s.items).flatMap((m) => m.parts);
	expect(line).toEqual({ type: 'data-alert', data: { job: 'x/../../f', kind: 'stuck' } });
});

test('text and calls keep their order through stream, final reply, snapshot and history', () => {
	const s = createState();
	const lines = [
		{ id: 't:0', name: 'read', summary: 'Read config', state: 'ok' as const, textOffset: 6 },
		{ id: 't:1', name: 'bash', summary: 'Check config', state: 'ok' as const, textOffset: 13 }
	];
	run(s, [
		{ type: 'delta', data: { turnId: 't', offset: 0, text: 'Before' } },
		{
			type: 'tool',
			data: { turnId: 't', id: 't:0', name: 'read', summary: 'Read config', textOffset: 6 }
		},
		{ type: 'delta', data: { turnId: 't', offset: 6, text: 'Between' } },
		{
			type: 'tool',
			data: { turnId: 't', id: 't:1', name: 'bash', summary: 'Check config', textOffset: 13 }
		},
		{ type: 'delta', data: { turnId: 't', offset: 13, text: 'After' } }
	]);
	const sequence = () =>
		toMessages(s.items)[0]
			.parts.filter((p) => p.type !== 'data-turn')
			.map((p) => (p.type === 'text' ? p.text : p.type === 'data-tool' ? p.data.tool : p.type));
	expect(sequence()).toEqual(['Before', 'read', 'Between', 'bash', 'After']);
	run(s, [
		{ type: 'reply', seq: 1, data: { key: 'reply', turnId: 't', text: 'After', files: [] } },
		{
			type: 'turn_final',
			seq: 2,
			data: {
				turnId: 't',
				outcome: 'done',
				summary: null,
				lines,
				activityText: 'BeforeBetweenAfter'
			}
		}
	]);
	expect(sequence()).toEqual(['Before', 'read', 'Between', 'bash', 'After']);
	const restored = createState();
	mergeHistory(restored, [
		{
			type: 'assistant',
			id: 'reply',
			at: 'now',
			turnId: 't',
			outboxId: 'reply',
			text: 'After',
			activityText: 'BeforeBetweenAfter',
			tools: lines.map(({ state, ...l }) => ({ ...l, ok: state === 'ok' })),
			files: []
		}
	]);
	expect(toMessages(restored.items)[0].parts).toEqual(toMessages(s.items)[0].parts);
});

test('an approval attaches to its call and resolves inside the same tool row', () => {
	const s = createState();
	run(s, [
		{
			type: 'tool',
			data: { turnId: 't', id: 'call', name: 'send_email', summary: 'Send email', textOffset: 0 }
		},
		{ type: 'approval', seq: 1, data: { nonce: 'nonce', view: view('send_email') } }
	]);
	expect(toMessages(s.items)).toHaveLength(1);
	expect(toMessages(s.items)[0].parts[0]).toMatchObject({
		type: 'data-tool',
		data: { approval: { nonce: 'nonce', outcome: 'pending' } }
	});
	run(s, [{ type: 'approval_resolved', seq: 2, data: { nonce: 'nonce', decision: 'approve' } }]);
	expect(s.approvals).toHaveLength(0);
	expect(toMessages(s.items)[0].parts[0]).toMatchObject({
		type: 'data-tool',
		data: { state: 'running', approval: { outcome: 'approved-elsewhere' } }
	});
});

test('child agent approval stays visible while child tool activity lives on its agent card', () => {
	const s = createState();
	run(s, [
		{
			type: 'tool',
			data: { turnId: 't', name: 'send_email', summary: 'Send email', agentId: 'child' }
		},
		{ type: 'approval', seq: 1, data: { nonce: 'nonce', view: view('send_email') } }
	]);
	expect(
		toMessages(s.items)
			.flatMap((m) => m.parts)
			.filter((part) => part.type === 'data-approval')
	).toHaveLength(1);
});
