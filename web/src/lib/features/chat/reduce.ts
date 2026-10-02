// Folds history pages, durable events and streaming deltas into chat state. No I/O: side effects
// come back as a list for the store to run, so the whole fold is testable without a browser.
import { isDurableEvent } from '$lib/core/realtime/events';
import type {
	ApprovalView,
	ChatEnvelope,
	ChatEventMap,
	ChatUsage,
	JobAlert,
	PendingState,
	RouterNotice,
	ToolLine,
	UploadRef,
	WebHistoryItem,
	WorkspaceState
} from '$lib/core/realtime/events';

export type Delivery =
	| 'sending'
	| 'sent'
	| 'failed'
	| 'queued'
	| 'queued-agent'
	/** The bot took the POST but queued it behind the running turn; it routes when that turn ends. */
	| 'queued-run'
	/** The bot acked it while a turn ran: the send steered that turn. */
	| 'steered';

export interface Attachment {
	name: string;
	/** Null when the bot no longer has the file. */
	ref: UploadRef | null;
	/** Local object URL while the message is still ours to send. */
	preview?: string;
}

export type TurnPhase = 'working' | 'done' | 'stopped' | 'interrupted';

export interface TurnState {
	phase: TurnPhase;
	lines: ToolLine[];
	startedAt: number;
	durationMs?: number;
	/** Replaces the step text, for command turns ("Starting a new chat…"). */
	label?: string;
}

export type ChatItem =
	| {
			kind: 'user';
			id: string;
			clientId?: string;
			text: string;
			attachments: Attachment[];
			at: string;
			delivery?: Delivery;
	  }
	| {
			kind: 'assistant';
			id: string;
			key?: string;
			turnId?: string;
			text: string;
			activityText?: string;
			files: UploadRef[];
			usage?: ChatUsage;
			turn?: TurnState;
			/** Still receiving deltas. */
			streaming: boolean;
			/** The durable reply landed; later deltas and snapshots for the turn are stale. */
			replied: boolean;
	  }
	| {
			kind: 'ask';
			id: string;
			askId: string;
			question: string;
			choices: string[];
			state: 'pending' | 'answering' | 'answered' | 'elsewhere' | 'history';
			answer?: string;
	  }
	| {
			kind: 'approval';
			id: string;
			nonce: string;
			tool: string;
			outcome:
				| 'pending'
				| 'approved'
				| 'denied'
				| 'timeout'
				| 'cancelled'
				| 'approved-elsewhere'
				| 'denied-elsewhere';
	  }
	| { kind: 'divider'; id: string; divider: 'new' | 'rotated' | 'compacted'; summary?: string }
	| { kind: 'line'; id: string; text: string }
	| { kind: 'auth'; id: string; url: string; instructions: string }
	/** A scheduled job's alert, shown as a system line. */
	| { kind: 'alert'; id: string; alert: JobAlert; at: string };

export interface TrayItem {
	nonce: string;
	view: ApprovalView;
}

export interface ChatState {
	items: ChatItem[];
	/** Pending approvals, oldest first. Filled only from the bot's approval events and approval log. */
	approvals: TrayItem[];
	/** Nonces the last first frame listed as waiting; a history item may re-open only these. */
	waiting: Set<string>;
	/** The tray item that just timed out; the store clears it after a few seconds. */
	timedOut: TrayItem | null;
	cursor: number | null;
	workspace: WorkspaceState | null;
	stopping: boolean;
	/** Dedupe keys of durable items already in `items`. */
	keys: Set<string>;
	/** Asks and approvals this device answered, to tell "you" from "another device". */
	mine: Set<string>;
	seq: number;
}

export type Effect =
	| { type: 'delivered'; clientId: string }
	/** The workspace refused the message; it waits for the owner's retry. */
	| { type: 'failed'; clientId: string }
	| { type: 'workspace'; state: WorkspaceState }
	/** A first frame says the workspace is online: re-send every entry the bot hasn't routed yet. */
	| { type: 'resend' }
	| { type: 'toast'; text: string }
	| { type: 'announce'; text: string }
	| { type: 'reload' }
	| { type: 'timedOut' };

export const PENDING_TURN_ID = 'turn:pending';

export function createState(): ChatState {
	return {
		items: [],
		approvals: [],
		waiting: new Set(),
		timedOut: null,
		cursor: null,
		workspace: null,
		stopping: false,
		keys: new Set(),
		mine: new Set(),
		seq: 0
	};
}

const uid = (s: ChatState, prefix: string) => `${prefix}:${++s.seq}`;

function assistantFor(s: ChatState, turnId: string) {
	return s.items.find(
		(i): i is Extract<ChatItem, { kind: 'assistant' }> =>
			i.kind === 'assistant' && i.turnId === turnId
	);
}

/** Gives the "Working…" placeholder to a turn, so the turn renders in the placeholder's slot. */
function adoptPlaceholder(s: ChatState, turnId: string) {
	const placeholder = s.items.find((i) => i.id === PENDING_TURN_ID);
	if (placeholder?.kind !== 'assistant') return undefined;
	placeholder.id = uid(s, 'turn');
	placeholder.turnId = turnId;
	if (placeholder.turn) placeholder.turn.label = undefined;
	return placeholder;
}

/** The live item for a turn, adopting the "Working…" placeholder or appending a new one. */
function turnItem(s: ChatState, turnId: string, now: number) {
	const found = assistantFor(s, turnId) ?? adoptPlaceholder(s, turnId);
	if (found) return found;
	const item: Extract<ChatItem, { kind: 'assistant' }> = {
		kind: 'assistant',
		id: uid(s, 'turn'),
		turnId,
		text: '',
		files: [],
		turn: { phase: 'working', lines: [], startedAt: now },
		streaming: true,
		replied: false
	};
	s.items.push(item);
	return item;
}

const live = (i: Extract<ChatItem, { kind: 'assistant' }>) =>
	!i.replied && (!i.turn || i.turn.phase === 'working');

function dropPlaceholder(s: ChatState) {
	s.items = s.items.filter((i) => i.id !== PENDING_TURN_ID);
}

export function addPlaceholder(s: ChatState, now: number, label?: string) {
	const running = s.items.some((i) => i.kind === 'assistant' && i.turn && live(i));
	if (running) return;
	s.items.push({
		kind: 'assistant',
		id: PENDING_TURN_ID,
		text: '',
		files: [],
		turn: { phase: 'working', lines: [], startedAt: now, label },
		streaming: false,
		replied: false
	});
}

export function noticeText(n: RouterNotice): { line?: string; toast?: string } {
	switch (n.type) {
		case 'workspaceOffline':
		case 'newSessionStarted':
			return {};
		case 'messageRejected':
			return { line: `Your message didn't reach the agent: ${n.error}` };
		case 'newSessionFailed':
			return { line: `Couldn't reset context: ${n.error}` };
		case 'newWhileOffline':
			return { toast: "Can't reset context while the agent is offline." };
		case 'nothingToStop':
			return { toast: 'Nothing to stop.' };
		case 'stopFailed':
			return { line: `Couldn't stop the turn: ${n.error}` };
		case 'transcriptionFailed':
			return { line: "Couldn't transcribe the voice message." };
		case 'transcript':
			return { line: `Transcript: ${n.text}` };
		case 'approvalExpired':
			return { toast: 'That approval had already expired.' };
		case 'askAlreadyAnswered':
			return { toast: 'That question was already answered.' };
		case 'askNotDelivered':
			return { line: `Your answer didn't reach the agent: ${n.error}` };
		case 'loginOffline':
			return { line: "Can't log in while the agent is offline." };
		case 'loginAlreadyPending':
			return { line: 'A login is already waiting for you to finish it.' };
		case 'loginNotPending':
			return { line: 'No login is waiting for a code.' };
		case 'loginCallbackIgnored':
			return { line: 'That login link was ignored.' };
		case 'loginCallbackRejected':
			return { line: `The login was rejected: ${n.error}` };
		case 'loginFailed':
			return { line: `Login failed: ${n.error}` };
		case 'loginUsage':
			return { line: "The login command wasn't understood." };
		case 'commandResult':
			return { line: n.text };
		case 'commandOffline':
			return { toast: "Can't run commands while the agent is offline." };
		case 'commandFailed':
			return { line: `The command failed: ${n.error}` };
	}
}

function applyToolEvent(item: Extract<ChatItem, { kind: 'assistant' }>, e: ChatEventMap['tool']) {
	const turn = (item.turn ??= { phase: 'working', lines: [], startedAt: Date.now() });
	if (e.ok === undefined) {
		turn.lines = [
			...turn.lines,
			{
				name: e.name,
				summary: e.summary,
				state: 'run',
				id: e.id,
				textOffset: e.textOffset ?? item.text.length,
				agentId: e.agentId
			}
		];
		return;
	}
	const state = e.ok ? 'ok' : 'err';
	const idx = turn.lines.findLastIndex((l) =>
		e.id ? l.id === e.id : l.name === e.name && l.agentId === e.agentId && l.state === 'run'
	);
	turn.lines =
		idx === -1
			? [
					...turn.lines,
					{
						name: e.name,
						summary: e.summary,
						state,
						id: e.id,
						textOffset: e.textOffset ?? item.text.length,
						agentId: e.agentId
					}
				]
			: turn.lines.map((l, i) =>
					i === idx ? { ...l, summary: e.summary || l.summary, state } : l
				);
}

function resolveApproval(s: ChatState, e: ChatEventMap['approval_resolved'], fx: Effect[]) {
	const top = s.approvals[0];
	const entry = s.approvals.find((a) => a.nonce === e.nonce);
	s.approvals = s.approvals.filter((a) => a.nonce !== e.nonce);
	const mine = s.mine.has(`p:${e.nonce}`);
	const decision = e.decision;
	const outcome =
		decision === 'approve'
			? mine
				? 'approved'
				: 'approved-elsewhere'
			: decision === 'deny'
				? mine
					? 'denied'
					: 'denied-elsewhere'
				: decision === 'timeout'
					? 'timeout'
					: 'cancelled';
	for (const i of s.items) if (i.kind === 'approval' && i.nonce === e.nonce) i.outcome = outcome;
	if (decision === 'timeout' && entry && top?.nonce === e.nonce) {
		s.timedOut = entry;
		fx.push({ type: 'timedOut' });
	}
}

function addApproval(s: ChatState, nonce: string, view: ApprovalView) {
	if (!s.approvals.some((a) => a.nonce === nonce)) s.approvals = [...s.approvals, { nonce, view }];
}

const PENDING_ASK_PREFIX = 'pending:';
const PENDING_APPROVAL_PREFIX = 'pending-approval:';

/**
 * The bot's own log of what is still waiting, from the first frame. It is authoritative for the tray:
 * an approval it doesn't list is no longer waiting. Approval markers come from history or replayed events.
 */
function applyPending(s: ChatState, p: PendingState) {
	const waiting = new Set(p.approvals.map((a) => a.nonce));
	s.waiting = waiting;
	for (const a of s.approvals) if (!waiting.has(a.nonce)) dropApproval(s, a.nonce, 'timeout');
	for (const a of p.approvals) {
		addApproval(s, a.nonce, a.view);
		const key = `p:${a.nonce}`;
		if (s.keys.has(key)) continue;
		s.keys.add(key);
		s.items.push({
			kind: 'approval',
			id: `${PENDING_APPROVAL_PREFIX}${a.nonce}`,
			nonce: a.nonce,
			tool: a.view.tool,
			outcome: 'pending'
		});
	}
	for (const a of p.asks) {
		const key = `a:${a.askId}`;
		if (s.keys.has(key)) continue;
		s.keys.add(key);
		s.items.push({
			kind: 'ask',
			id: `${PENDING_ASK_PREFIX}${a.askId}`,
			askId: a.askId,
			question: a.question,
			choices: a.choices,
			state: 'pending'
		});
	}
}

/** Drops everything but unsent messages and first-frame asks ahead of a history reload. The tray and
 *  cursor stay. */
export function restartHistory(s: ChatState): Effect[] {
	// `steered` is settled like `sent`: the bot holds the message, so history carries it back.
	const keep = s.items.filter(
		(i) =>
			(i.kind === 'user' && i.delivery && i.delivery !== 'sent' && i.delivery !== 'steered') ||
			(i.kind === 'ask' && i.id.startsWith(PENDING_ASK_PREFIX))
	);
	Object.assign(s, createState(), {
		items: keep,
		workspace: s.workspace,
		mine: s.mine,
		approvals: s.approvals,
		waiting: s.waiting,
		cursor: s.cursor
	});
	for (const i of keep) {
		if (i.kind === 'user' && i.clientId) s.keys.add(`u:${i.clientId}`);
		if (i.kind === 'ask') s.keys.add(`a:${i.askId}`);
	}
	return [{ type: 'reload' }];
}

/** Applies one live event. Durable events at or below the cursor are replays and are skipped. */
export function applyEvent(s: ChatState, ev: ChatEnvelope, now = Date.now()): Effect[] {
	const fx: Effect[] = [];
	if (ev.seq !== undefined && isDurableEvent(ev.type)) {
		if (s.cursor !== null && ev.seq <= s.cursor) return fx;
		s.cursor = ev.seq;
	}
	switch (ev.type) {
		case 'hello': {
			if (s.cursor === null) s.cursor = ev.data.headSeq;
			setWorkspace(s, ev.data.workspace, fx);
			// Even with no change: the bot may have restarted and lost a message it answered 202 for.
			if (ev.data.workspace === 'online') fx.push({ type: 'resend' });
			for (const view of ev.data.openTurns) {
				fx.push(...applyEvent(s, { type: 'snapshot', data: { turnId: view.turnId, view } }, now));
			}
			applyPending(s, ev.data.pending);
			break;
		}
		case 'reset': {
			fx.push(...restartHistory(s));
			s.cursor = ev.data.headSeq;
			// The history reload that follows re-sends unsettled entries when this says online.
			setWorkspace(s, ev.data.workspace, fx);
			applyPending(s, ev.data.pending);
			break;
		}
		case 'user': {
			const key = `u:${ev.data.key}`;
			if (s.keys.has(key)) break;
			s.keys.add(key);
			if (s.items.some((i) => i.kind === 'user' && i.clientId === ev.data.key)) break;
			s.items.push({
				kind: 'user',
				id: uid(s, 'user'),
				clientId: ev.data.key,
				text: ev.data.text,
				attachments: ev.data.uploadIds.map((id) => ({
					name: 'Photo',
					ref: { id, contentType: 'image/jpeg', bytes: 0, name: 'Photo', inline: true }
				})),
				at: ev.data.at
			});
			break;
		}
		case 'status': {
			// A steer joins the turn that is already running, so it settles without a Working row.
			const steered = ev.data.state === 'steer';
			// The bot holds the message behind the running turn: posted, but not routed yet, so it
			// stays unsettled — Delete still withdraws it and no receipt has left the outbox.
			const queued = ev.data.state === 'queued';
			for (const i of s.items) {
				if (i.kind === 'user' && i.clientId === ev.data.clientId)
					i.delivery = steered ? 'steered' : queued ? 'queued-run' : 'sent';
			}
			if (!queued) fx.push({ type: 'delivered', clientId: ev.data.clientId });
			if (ev.data.state === 'accepted' || ev.data.state === 'newSession') addPlaceholder(s, now);
			break;
		}
		case 'reply':
		case 'proactive': {
			const key = `r:${ev.data.key}`;
			if (s.keys.has(key)) break;
			s.keys.add(key);
			const target = ev.data.turnId ? assistantFor(s, ev.data.turnId) : undefined;
			if (target && !target.replied) {
				Object.assign(target, {
					key: ev.data.key,
					activityText: target.text,
					text: ev.data.text,
					files: ev.data.files,
					usage: ev.data.usage,
					streaming: false,
					replied: true
				});
			} else {
				s.items.push({
					kind: 'assistant',
					id: uid(s, 'reply'),
					key: ev.data.key,
					turnId: ev.data.turnId,
					text: ev.data.text,
					files: ev.data.files,
					usage: ev.data.usage,
					streaming: false,
					replied: true
				});
			}
			fx.push({ type: 'announce', text: 'Agent replied' });
			break;
		}
		case 'turn_final': {
			const item = assistantFor(s, ev.data.turnId);
			s.stopping = false;
			dropPlaceholder(s);
			if (!item) break;
			item.streaming = false;
			if (ev.data.activityText) item.activityText = ev.data.activityText;
			const phase: TurnPhase =
				ev.data.outcome === 'done'
					? 'done'
					: ev.data.outcome === 'stopped'
						? 'stopped'
						: 'interrupted';
			item.turn = {
				...(item.turn ?? { lines: [], startedAt: now }),
				phase,
				durationMs: ev.data.summary?.durationMs,
				...(ev.data.lines ? { lines: ev.data.lines } : {})
			};
			if (!item.text && !item.turn.lines.length && phase === 'done') {
				s.items = s.items.filter((i) => i !== item);
			}
			break;
		}
		case 'snapshot': {
			const existing = assistantFor(s, ev.data.turnId);
			if (existing && !live(existing)) break;
			const item = turnItem(s, ev.data.turnId, now);
			const v = ev.data.view;
			item.text = v.text;
			item.streaming = true;
			item.turn = { phase: 'working', lines: [...v.lines], startedAt: v.startedAt };
			break;
		}
		case 'delta': {
			const existing = assistantFor(s, ev.data.turnId);
			if (existing && !live(existing)) break;
			if (!existing && ev.data.offset !== 0) break;
			const item = existing ?? turnItem(s, ev.data.turnId, now);
			if (ev.data.offset !== item.text.length) break;
			item.text += ev.data.text;
			item.streaming = true;
			break;
		}
		case 'tool': {
			const existing = assistantFor(s, ev.data.turnId);
			if (existing && !live(existing)) break;
			applyToolEvent(existing ?? turnItem(s, ev.data.turnId, now), ev.data);
			break;
		}
		case 'ask': {
			const key = `a:${ev.data.askId}`;
			if (s.keys.has(key)) break;
			s.keys.add(key);
			s.items.push({
				kind: 'ask',
				id: uid(s, 'ask'),
				askId: ev.data.askId,
				question: ev.data.question,
				choices: ev.data.choices,
				state: 'pending'
			});
			break;
		}
		case 'ask_resolved': {
			const mine = s.mine.has(`a:${ev.data.askId}`);
			for (const i of s.items) {
				if (i.kind !== 'ask' || i.askId !== ev.data.askId) continue;
				if (ev.data.answer === null) {
					i.state = 'history';
					i.answer = undefined;
				} else {
					i.state = mine ? 'answered' : 'elsewhere';
					i.answer = ev.data.answer;
				}
			}
			break;
		}
		case 'auth': {
			const key = `auth:${ev.data.key}`;
			if (s.keys.has(key)) break;
			s.keys.add(key);
			s.items.push({
				kind: 'auth',
				id: uid(s, 'auth'),
				url: ev.data.url,
				instructions: ev.data.instructions
			});
			break;
		}
		case 'approval': {
			// The bot's own event always reaches the tray, even when history already drew the marker.
			addApproval(s, ev.data.nonce, ev.data.view);
			const key = `p:${ev.data.nonce}`;
			if (s.keys.has(key)) break;
			s.keys.add(key);
			s.items.push({
				kind: 'approval',
				id: uid(s, 'approval'),
				nonce: ev.data.nonce,
				tool: ev.data.view.tool,
				outcome: 'pending'
			});
			break;
		}
		case 'approval_resolved':
			resolveApproval(s, ev.data, fx);
			break;
		case 'notice': {
			const clientId = ev.data.clientId || undefined;
			if (clientId && ev.data.type === 'messageRejected') {
				setDelivery(s, clientId, 'failed');
				fx.push({ type: 'failed', clientId });
			} else if (clientId && ev.data.type !== 'workspaceOffline') {
				// The router handled the message, so the notice settles it.
				setDelivery(s, clientId, 'sent');
				fx.push({ type: 'delivered', clientId });
			}
			// The workspace state comes only from first frames and `workspace` events, never from a notice.
			if (ev.data.type === 'workspaceOffline') {
				for (const i of s.items) {
					if (i.kind !== 'user' || !i.delivery || i.delivery === 'failed') continue;
					if (i.delivery === 'sending' || i.clientId === clientId) i.delivery = 'queued-agent';
				}
				dropPlaceholder(s);
			}
			if (ev.data.type === 'nothingToStop' || ev.data.type === 'stopFailed') s.stopping = false;
			const { line, toast } = noticeText(ev.data);
			if (line) s.items.push({ kind: 'line', id: uid(s, 'line'), text: line });
			if (toast) fx.push({ type: 'toast', text: toast });
			break;
		}
		case 'session': {
			dropPlaceholder(s);
			s.items.push({
				kind: 'divider',
				id: uid(s, 'divider'),
				divider: ev.data.kind === 'new' ? 'new' : 'compacted'
			});
			break;
		}
		case 'workspace':
			setWorkspace(s, ev.data.state, fx);
			break;
		case 'alert': {
			// Same key as the history copy (its outboxId), so the alert shows once.
			const key = `l:${ev.data.key}`;
			if (s.keys.has(key)) break;
			s.keys.add(key);
			s.items.push({
				kind: 'alert',
				id: uid(s, 'alert'),
				alert: ev.data.alert,
				at: new Date(now).toISOString()
			});
			break;
		}
		case 'alert_cleared':
			// Home's state only: a recovery arrives as its own `alert`, a dismissal changes no chat line.
			break;
	}
	return fx;
}

function setWorkspace(s: ChatState, state: WorkspaceState, fx: Effect[]) {
	if (s.workspace === state) return;
	s.workspace = state;
	fx.push({ type: 'workspace', state });
}

function fromHistory(s: ChatState, h: WebHistoryItem): ChatItem | null {
	switch (h.type) {
		case 'user':
			if (h.clientId) {
				if (s.keys.has(`u:${h.clientId}`)) return null;
				s.keys.add(`u:${h.clientId}`);
			}
			return {
				kind: 'user',
				id: `h:${h.id}`,
				clientId: h.clientId,
				text: h.text,
				attachments: h.attachments.map((a) => ({ name: a.name, ref: a.file })),
				at: h.at
			};
		case 'assistant':
			if (h.outboxId) {
				if (s.keys.has(`r:${h.outboxId}`)) return null;
				s.keys.add(`r:${h.outboxId}`);
			}
			return {
				kind: 'assistant',
				id: `h:${h.id}`,
				key: h.outboxId,
				turnId: h.turnId,
				text: h.text,
				activityText: h.activityText,
				files: h.files,
				usage: h.usage,
				turn: h.tools.length
					? {
							phase: 'done',
							startedAt: 0,
							lines: h.tools.map((t) => ({
								...t,
								summary: t.summary,
								state: t.ok ? 'ok' : 'err'
							}))
						}
					: undefined,
				streaming: false,
				replied: true
			};
		case 'ask':
			if (s.keys.has(`a:${h.askId}`)) return null;
			s.keys.add(`a:${h.askId}`);
			return {
				kind: 'ask',
				id: `h:${h.id}`,
				askId: h.askId,
				question: h.question,
				choices: h.choices,
				// Only an ask with no answer yet is still answerable; a null answer is a dead ask.
				state: h.answer === undefined ? 'pending' : 'history',
				answer: h.answer ?? undefined
			};
		case 'divider':
			return { kind: 'divider', id: `h:${h.id}`, divider: h.kind, summary: h.summary };
		case 'alert':
			if (s.keys.has(`l:${h.outboxId}`)) return null;
			s.keys.add(`l:${h.outboxId}`);
			return { kind: 'alert', id: `h:${h.id}`, alert: h.alert, at: h.at };
		case 'approval':
			if (s.keys.has(`p:${h.nonce}`)) return null;
			s.keys.add(`p:${h.nonce}`);
			// An undecided row the first frame didn't list is stale (e.g. its timeout was lost in a restart).
			if (h.decision === null && s.waiting.has(h.nonce)) addApproval(s, h.nonce, h.view);
			return {
				kind: 'approval',
				id: `h:${h.id}`,
				nonce: h.nonce,
				tool: h.view.tool,
				outcome:
					h.decision === null
						? 'pending'
						: h.decision === 'approve'
							? 'approved'
							: h.decision === 'deny'
								? 'denied'
								: h.decision === 'cancelled'
									? 'cancelled'
									: 'timeout'
			};
	}
}

/**
 * Merges one oldest-first history page ahead of the items held. A send the page contains already
 * sits in the bot's log, so it moves into the page and settles; so does an ask seeded from the first frame.
 */
export function mergeHistory(s: ChatState, items: WebHistoryItem[]): Effect[] {
	const fx: Effect[] = [];
	const local = new Map<string, Extract<ChatItem, { kind: 'user' }>>();
	const seededAsks = new Map<string, ChatItem>();
	const seededApprovals = new Map<string, ChatItem>();
	for (const i of s.items) {
		if (i.kind === 'user' && i.clientId) local.set(i.clientId, i);
		if (i.kind === 'ask' && i.id.startsWith(PENDING_ASK_PREFIX)) seededAsks.set(i.askId, i);
		if (i.kind === 'approval' && i.id.startsWith(PENDING_APPROVAL_PREFIX))
			seededApprovals.set(i.nonce, i);
	}
	const moved = new Set<ChatItem>();
	const mapped: ChatItem[] = [];
	for (const h of items) {
		const seeded =
			h.type === 'ask'
				? seededAsks.get(h.askId)
				: h.type === 'approval'
					? seededApprovals.get(h.nonce)
					: undefined;
		if (seeded && !moved.has(seeded)) {
			moved.add(seeded);
			if (h.type === 'approval') seeded.id = `h:${h.id}`;
			mapped.push(seeded);
			continue;
		}
		const mine = h.type === 'user' && h.clientId ? local.get(h.clientId) : undefined;
		if (mine && h.type === 'user' && h.clientId) {
			// Settled sends (`sent`, `steered`) move in as they are; an unsettled one the page
			// carries already sits in the bot's log, so it settles and leaves the outbox.
			if (mine.delivery && mine.delivery !== 'sent' && mine.delivery !== 'steered') {
				mine.delivery = 'sent';
				fx.push({ type: 'delivered', clientId: h.clientId });
			}
			moved.add(mine);
			mapped.push(mine);
			continue;
		}
		const item = fromHistory(s, h);
		if (item) mapped.push(item);
	}
	s.items = [...mapped, ...s.items.filter((i) => !moved.has(i))];
	return fx;
}

/** Takes an approval off the tray without an event, when the bot says it is no longer pending. */
export function dropApproval(s: ChatState, nonce: string, outcome: 'timeout' | 'cancelled') {
	s.approvals = s.approvals.filter((a) => a.nonce !== nonce);
	s.mine.delete(`p:${nonce}`);
	for (const i of s.items) {
		if (i.kind === 'approval' && i.nonce === nonce && i.outcome === 'pending') i.outcome = outcome;
	}
}

/** The optimistic bubble for a send, before any network call. */
export function addLocalSend(
	s: ChatState,
	m: { clientId: string; text: string; attachments: Attachment[]; at: string; delivery: Delivery }
) {
	s.keys.add(`u:${m.clientId}`);
	s.items.push({ kind: 'user', id: `local:${m.clientId}`, ...m });
}

export function setDelivery(s: ChatState, clientId: string, delivery: Delivery | undefined) {
	for (const i of s.items) if (i.kind === 'user' && i.clientId === clientId) i.delivery = delivery;
}

export function removeLocal(s: ChatState, clientId: string) {
	s.items = s.items.filter((i) => !(i.kind === 'user' && i.clientId === clientId));
	s.keys.delete(`u:${clientId}`);
}

export function markAsk(s: ChatState, askId: string, answer: string | null) {
	s.mine.add(`a:${askId}`);
	for (const i of s.items) {
		if (i.kind === 'ask' && i.askId === askId) {
			if (answer === null) {
				if (i.state === 'answering') {
					i.state = 'pending';
					i.answer = undefined;
				}
			} else {
				i.state = 'answering';
				i.answer = answer;
			}
		}
	}
}

export function openTurns(s: ChatState) {
	return s.items.filter(
		(i): i is Extract<ChatItem, { kind: 'assistant' }> =>
			i.kind === 'assistant' && !!i.turn && live(i)
	);
}
