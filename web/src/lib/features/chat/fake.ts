// A scripted in-memory bot for `bun dev` with `?fake`: it speaks the same events and routes as the
// real gateway, so the chat screen can be driven without the bot or a workspace.
import type { ChatApi } from './api';
import type {
	ChatEnvelope,
	ChatEventMap,
	ChatEventType,
	WebHistoryItem,
	WorkspaceState
} from '$lib/core/realtime/events';
import type { ChatTransport } from '$lib/core/realtime/transport';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 10);
const uploadId = () =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(22)),
		(b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]
	).join('');

const REPLY =
	'I checked your mail and the calendar. The invoice from Eastside Auto is due on the 14th, and the amount matches the quote you approved last month. Want me to schedule the payment for the 12th so it clears in time?';

function history(): WebHistoryItem[] {
	const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
	const items: WebHistoryItem[] = [];
	for (let i = 30; i > 0; i--) {
		items.push(
			{
				type: 'user',
				id: `hu${i}`,
				clientId: undefined,
				at: at(i * 10 + 5),
				text: `Earlier question number ${i}`,
				attachments: [],
				verified: i < 20
			},
			{
				type: 'assistant',
				id: `ha${i}`,
				at: at(i * 10),
				text: `Earlier answer number ${i}.`,
				tools: i % 3 ? [] : [{ name: 'search_mail', summary: 'Searched mail', ok: true }],
				files: [],
				verified: i < 20
			}
		);
		if (i === 12)
			items.push({
				type: 'divider',
				id: 'hd',
				at: at(115),
				kind: 'compacted',
				summary: 'Talked about car service and invoices.'
			});
	}
	return items;
}

export function createFakeBackend(): { transport: ChatTransport; api: ChatApi } {
	let seq = 100;
	let workspace: WorkspaceState = 'online';
	const sinks = new Set<(ev: ChatEnvelope) => void>();
	const all = history();
	let turn: { id: string; stopped: boolean } | null = null;
	const asks = new Map<string, string[]>();

	function emit<T extends ChatEventType>(type: T, data: ChatEventMap[T], durable = true) {
		const ev = { type, data, ...(durable ? { seq: ++seq } : {}) } as ChatEnvelope;
		for (const s of sinks) s(ev);
	}

	async function runTurn(text: string) {
		const id = rid();
		turn = { id, stopped: false };
		const alive = () => turn?.id === id && !turn.stopped;
		const started = Date.now();
		await sleep(400);
		const steps = [
			['search_mail', "Searching mail for 'invoice'"],
			['read_calendar', 'Reading the calendar for this week'],
			['fetch_url', 'Opening eastside-auto.example/billing']
		];
		for (const [name, summary] of steps) {
			if (!alive()) return;
			emit('tool', { turnId: id, name, summary }, false);
			await sleep(700);
			emit(
				'tool',
				{ turnId: id, name, summary, ok: !text.includes('fail') || name !== 'read_calendar' },
				false
			);
		}
		if (text.includes('approve')) {
			const nonce = rid();
			emit('approval', {
				nonce,
				view: {
					tool: 'send_email',
					agentId: 'main',
					agentName: 'Main',
					fields: [
						{ key: 'to', value: 'dana@example.com', kind: 'single', max: 200 },
						{ key: 'subject', value: 'Re: invoice #1042', kind: 'single', max: 200 },
						{
							key: 'body',
							value: 'Hi Dana,\n\nThe payment goes out on the 12th.\n\nThanks',
							kind: 'body'
						}
					]
				}
			});
		}
		if (text.includes('ask')) {
			const askId = rid();
			const choices = ['Pay on the 12th', 'Pay now', 'Skip it'];
			asks.set(askId, choices);
			emit('ask', { key: rid(), askId, question: 'When should I pay the invoice?', choices });
		}
		let offset = 0;
		for (const word of REPLY.split(/(?<= )/)) {
			if (!alive()) break;
			emit('delta', { turnId: id, offset, text: word }, false);
			offset += word.length;
			await sleep(40);
		}
		if (turn?.id !== id) return;
		const stopped = turn.stopped;
		if (!stopped) {
			emit('reply', {
				key: rid(),
				turnId: id,
				text: REPLY,
				files: text.includes('file')
					? [
							{
								id: uploadId(),
								contentType: 'application/pdf',
								bytes: 48_213,
								name: 'invoice-1042.pdf',
								inline: false
							}
						]
					: []
			});
		}
		emit('turn_final', {
			turnId: id,
			outcome: stopped ? 'stopped' : 'done',
			summary: { durationMs: Date.now() - started, toolCount: steps.length }
		});
		turn = null;
	}

	const transport: ChatTransport = {
		connect(_after, on, onState) {
			const sink = (ev: ChatEnvelope) => on(ev);
			sinks.add(sink);
			setTimeout(() => {
				onState('open');
				on({
					type: 'hello',
					data: { headSeq: seq, workspace, openTurns: [], pending: { approvals: [], asks: [] } }
				});
			}, 200);
			return () => sinks.delete(sink);
		}
	};

	const api: ChatApi = {
		async history({ before, limit }) {
			await sleep(300);
			const end = before ? Number(before) : all.length;
			const start = Math.max(0, end - limit);
			return {
				ok: true,
				page: { items: all.slice(start, end), before: start > 0 ? String(start) : null }
			};
		},
		async postMessage({ clientId, text, uploadIds }) {
			await sleep(150);
			emit('user', {
				key: clientId,
				text,
				uploadIds: uploadIds ?? [],
				at: new Date().toISOString()
			});
			if (text === 'offline') {
				workspace = 'offline';
				emit('workspace', { state: 'offline' }, false);
				emit('notice', { type: 'workspaceOffline' });
				setTimeout(() => {
					workspace = 'online';
					emit('workspace', { state: 'online' }, false);
				}, 6000);
				return { seq, routed: false };
			}
			if (workspace === 'offline') {
				emit('notice', { type: 'workspaceOffline' });
				return { seq, routed: false };
			}
			emit('status', { clientId, state: turn ? 'steer' : 'accepted' });
			if (!turn) void runTurn(text);
			return { seq, routed: true };
		},
		async discardMessage() {
			await sleep(150);
			return 'discarded';
		},
		async stop() {
			await sleep(200);
			if (turn) turn.stopped = true;
			else emit('notice', { type: 'nothingToStop' });
		},
		async command(command) {
			await sleep(1500);
			emit('session', { kind: command === 'new' ? 'new' : 'compacted' });
		},
		async answerAsk(askId, body) {
			await sleep(400);
			const choices = asks.get(askId) ?? [];
			emit('ask_resolved', {
				askId,
				answer: 'text' in body ? body.text : (choices[body.index] ?? body.label)
			});
			return { status: 'answered' };
		},
		async decide(nonce, { decision }) {
			await sleep(400);
			emit('approval_resolved', { nonce, decision });
			return { status: 'decided' };
		},
		async seen() {},
		async upload(blob, _meta, onProgress) {
			for (let p = 0; p <= 100; p += 20) {
				onProgress(p);
				await sleep(150);
			}
			return { id: uploadId(), contentType: 'image/jpeg', bytes: blob.size };
		}
	};

	return { transport, api };
}
