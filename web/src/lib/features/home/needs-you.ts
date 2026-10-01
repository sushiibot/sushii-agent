import type { ChatEnvelope, PendingState } from '$lib/core/realtime/events';
import type { AskView } from '$lib/features/chat';
import type { HomeData, HomeGroups, HomeItem, TurnItem } from './types';

/** What Home keeps from the stream: the bot's pending items and Main's open turns. */
export interface LiveState {
	greeted: boolean;
	approvals: PendingState['approvals'];
	asks: PendingState['asks'];
	turns: TurnItem[];
}

export const emptyLive = (): LiveState => ({ greeted: false, approvals: [], asks: [], turns: [] });

/** Applies one stream event; returns the next state, or the same object when nothing changed. */
export function applyLive(s: LiveState, ev: ChatEnvelope, now = Date.now()): LiveState {
	switch (ev.type) {
		case 'hello':
			return {
				greeted: true,
				approvals: ev.data.pending.approvals,
				asks: ev.data.pending.asks,
				turns: ev.data.openTurns.map((t) => ({
					turnId: t.turnId,
					startedAt: t.startedAt,
					step: t.lines.at(-1)?.summary,
					toolCount: t.toolCount
				}))
			};
		case 'reset':
			return {
				...s,
				greeted: true,
				approvals: ev.data.pending.approvals,
				asks: ev.data.pending.asks
			};
		case 'approval': {
			if (s.approvals.some((a) => a.nonce === ev.data.nonce)) return s;
			const at = new Date(now).toISOString();
			const item = { seq: ev.seq ?? 0, at, nonce: ev.data.nonce, view: ev.data.view };
			return { ...s, approvals: [...s.approvals, item] };
		}
		case 'approval_resolved':
			return { ...s, approvals: s.approvals.filter((a) => a.nonce !== ev.data.nonce) };
		case 'ask': {
			if (s.asks.some((a) => a.askId === ev.data.askId)) return s;
			const at = new Date(now).toISOString();
			return { ...s, asks: [...s.asks, { seq: ev.seq ?? 0, at, ...ev.data }] };
		}
		case 'ask_resolved':
			return { ...s, asks: s.asks.filter((a) => a.askId !== ev.data.askId) };
		case 'snapshot': {
			const { turnId, view } = ev.data;
			const turn: TurnItem = {
				turnId,
				startedAt: view.startedAt,
				step: view.lines.at(-1)?.summary,
				toolCount: view.toolCount
			};
			return { ...s, turns: [...s.turns.filter((t) => t.turnId !== turnId), turn] };
		}
		case 'tool': {
			const { turnId, summary } = ev.data;
			const found = s.turns.find((t) => t.turnId === turnId);
			const running = ev.data.ok === undefined;
			const turn: TurnItem = found
				? {
						...found,
						step: running ? summary : found.step,
						toolCount: found.toolCount + (running ? 1 : 0)
					}
				: { turnId, startedAt: now, step: summary, toolCount: 1 };
			return { ...s, turns: [...s.turns.filter((t) => t.turnId !== turnId), turn] };
		}
		case 'turn_final':
			return { ...s, turns: s.turns.filter((t) => t.turnId !== ev.data.turnId) };
		default:
			return s;
	}
}

/** Choices made from Home that the stream hasn't confirmed yet. */
export interface LocalState {
	/** Dismissed failures and items marked done. */
	dismissed: readonly string[];
	/** Inbox items opened, so shown read. */
	opened: readonly string[];
	asks: Readonly<Record<string, Pick<AskView, 'state' | 'answer'>>>;
}

const newestFirst = (a: HomeItem, b: HomeItem) => b.at.localeCompare(a.at);

/** Home's four groups: what is waiting on you, what failed, what is running, what is new. */
export function homeItems(
	live: LiveState,
	data: HomeData | null | undefined,
	local: LocalState
): HomeGroups {
	const waiting: HomeItem[] = [
		...live.approvals.map((a): HomeItem => ({
			id: `approval:${a.nonce}`,
			group: 'waiting',
			kind: 'approval',
			at: a.at,
			approval: { nonce: a.nonce, view: a.view }
		})),
		...live.asks.map((a): HomeItem => ({
			id: `ask:${a.askId}`,
			group: 'waiting',
			kind: 'ask',
			at: a.at,
			ask: {
				askId: a.askId,
				question: a.question,
				choices: a.choices,
				...(local.asks[a.askId] ?? { state: 'pending' })
			}
		}))
	];
	if (data?.auth) waiting.push({ id: 'auth', group: 'waiting', kind: 'auth', at: data.auth.at });

	const dismissed = new Set(local.dismissed);
	const opened = new Set(local.opened);
	const online = data?.workspace.state === 'online' ? data.workspace : null;
	const failed: HomeItem[] = [
		...(data?.failed ?? []).map((alert): HomeItem => ({
			id: alert.id,
			group: 'failed',
			kind: 'alert',
			at: alert.lastAt,
			alert
		})),
		...(online?.failedRuns ?? []).map((run): HomeItem => ({
			id: `run:${run.runId}`,
			group: 'failed',
			kind: 'run',
			at: run.endedAt ?? run.startedAt,
			run
		}))
	].filter((i) => !dismissed.has(i.id));

	const running: HomeItem[] = [
		...live.turns.map((turn): HomeItem => ({
			id: `turn:${turn.turnId}`,
			group: 'running',
			kind: 'turn',
			at: new Date(turn.startedAt).toISOString(),
			turn
		})),
		...(online?.running ?? []).map((run): HomeItem => ({
			id: `run:${run.runId}`,
			group: 'running',
			kind: 'run',
			at: run.startedAt,
			run
		}))
	];

	const review: HomeItem[] = [
		...(data?.inbox ?? []).map((message): HomeItem => {
			const id = `msg:${message.key}`;
			return {
				id,
				group: 'review',
				kind: 'message',
				at: message.at,
				message,
				read: message.read || opened.has(id)
			};
		}),
		...(online?.review ?? []).map(({ read, ...run }): HomeItem => {
			const id = `run:${run.runId}`;
			return {
				id,
				group: 'review',
				kind: 'run',
				at: run.endedAt ?? run.startedAt,
				run,
				read: read || opened.has(id)
			};
		})
	].filter((i) => !dismissed.has(i.id));

	return {
		waiting: waiting.sort((a, b) => a.at.localeCompare(b.at)),
		failed: failed.sort(newestFirst),
		running: running.sort(newestFirst),
		review: review.sort(newestFirst)
	};
}

/** The Home item a deep link names: `?approve=`, `?ask=` (pushes from M1) or `?item=`. */
export function deepLinkItem(params: URLSearchParams): string | null {
	const approve = params.get('approve');
	if (approve) return `approval:${approve}`;
	const ask = params.get('ask');
	if (ask) return `ask:${ask}`;
	return params.get('item');
}
