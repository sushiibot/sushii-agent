/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { ChatEnvelope } from '$lib/core/realtime/events';
import { RUN_ID_RE } from '$lib/features/runs/types';
import { emailApproval, HEARTBEAT_KEY, homeData, RUN_IDS } from './fixtures';
import { applyLive, deepLinkItem, emptyLive, homeItems, type LocalState } from './needs-you';
import type { HomeGroups } from './types';

const NOW = Date.parse('2026-09-30T16:41:00Z');
const local: LocalState = { dismissed: [], opened: [], asks: {} };

const hello: ChatEnvelope = {
	type: 'hello',
	data: {
		headSeq: 9,
		workspace: 'online',
		openTurns: [
			{
				turnId: 't1',
				startedAt: NOW - 5000,
				lines: [{ name: 'search_mail', summary: 'Searching mail', state: 'run' }],
				toolCount: 1,
				text: ''
			}
		],
		pending: {
			approvals: [{ seq: 3, at: '2026-09-30T16:30:00Z', nonce: 'n1', view: emailApproval.view }],
			asks: [
				{
					seq: 4,
					at: '2026-09-30T16:20:00Z',
					key: 'k',
					askId: 'a1',
					question: 'Q?',
					choices: ['A']
				}
			]
		}
	}
};

test('hello fills waiting and running; resolutions and turn ends take items off', () => {
	let s = applyLive(emptyLive(), hello, NOW);
	expect(s.greeted).toBe(true);
	expect(homeItems(s, undefined, local).waiting.map((i) => i.id)).toEqual([
		'ask:a1',
		'approval:n1'
	]);
	expect(homeItems(s, undefined, local).running.map((i) => i.id)).toEqual(['turn:t1']);
	s = applyLive(
		s,
		{ type: 'tool', data: { turnId: 't1', name: 'x', summary: 'Reading the calendar' } },
		NOW
	);
	expect(s.turns[0]).toMatchObject({ step: 'Reading the calendar', toolCount: 2 });
	s = applyLive(s, { type: 'approval_resolved', data: { nonce: 'n1', decision: 'deny' } }, NOW);
	s = applyLive(s, { type: 'ask_resolved', data: { askId: 'a1', answer: 'A' } }, NOW);
	s = applyLive(
		s,
		{ type: 'turn_final', data: { turnId: 't1', outcome: 'done', summary: null } },
		NOW
	);
	const groups = homeItems(s, undefined, local);
	expect(groups.waiting).toEqual([]);
	expect(groups.running).toEqual([]);
});

test('an unrelated event returns the same state, so nothing re-renders', () => {
	const s = applyLive(emptyLive(), hello, NOW);
	expect(applyLive(s, { type: 'workspace', data: { state: 'offline' } }, NOW)).toBe(s);
	expect(
		applyLive(s, { type: 'approval', data: { nonce: 'n1', view: emailApproval.view } }, NOW)
	).toBe(s);
});

test('dismissed items leave Failed; opened inbox items stay, read; done ones leave', () => {
	const data = homeData(NOW);
	const flights = `run:${RUN_IDS.flights}`;
	const expenses = `run:${RUN_IDS.expenses}`;
	const heartbeat = `msg:${HEARTBEAT_KEY}`;
	const read = (g: HomeGroups) => g.review.map((i) => [i.id, 'read' in i && i.read]);
	const all = homeItems(emptyLive(), data, local);
	expect(all.failed.map((i) => i.id)).toEqual(['job:nightly-sync', flights]);
	expect(read(all)).toEqual([
		[heartbeat, false],
		[expenses, false]
	]);
	const after = homeItems(emptyLive(), data, {
		...local,
		dismissed: ['job:nightly-sync'],
		opened: [flights, expenses]
	});
	expect(after.failed.map((i) => i.id)).toEqual([flights]);
	expect(read(after)).toEqual([
		[heartbeat, false],
		[expenses, true]
	]);
	const done = homeItems(emptyLive(), data, { ...local, dismissed: [heartbeat] });
	expect(done.review.map((i) => i.id)).toEqual([expenses]);
});

test('a workspace that is not online contributes no running or failed runs', () => {
	const data = { ...homeData(NOW), workspace: { state: 'offline' as const } };
	const groups = homeItems(emptyLive(), data, local);
	expect(groups.running).toEqual([]);
	expect(groups.failed.map((i) => i.kind)).toEqual(['alert']);
});

test('push links name the item they open', () => {
	expect(deepLinkItem(new URLSearchParams('approve=n1'))).toBe('approval:n1');
	expect(deepLinkItem(new URLSearchParams('ask=a%201'))).toBe('ask:a 1');
	expect(deepLinkItem(new URLSearchParams('item=job:nightly-sync'))).toBe('job:nightly-sync');
	expect(deepLinkItem(new URLSearchParams(''))).toBeNull();
});

test('fixture run ids are real ULIDs', () => {
	for (const id of Object.values(RUN_IDS)) expect(id).toMatch(RUN_ID_RE);
});
