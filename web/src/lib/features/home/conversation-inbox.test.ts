import { expect, test } from 'bun:test';
import { conversationInbox, inboxConversation } from './conversation-inbox';
import { busyGroups } from './fixtures';
import type { HomeItem } from './types';

const now = Date.now();

test('main stream items stay with Main; recorded topic runs stay with their topic', () => {
	const groups = busyGroups(now);
	const run = groups.running.find((item) => item.kind === 'run')!;
	if (run.kind !== 'run') throw new Error('Missing run fixture');
	run.run.conversationId = 'trip';
	expect(inboxConversation(run, groups)).toBe('trip');
	expect(conversationInbox(groups, 'trip', ['trip']).running).toEqual([run]);
	expect(conversationInbox(groups, 'main', ['trip']).running).not.toContain(run);
	expect(
		conversationInbox(groups, 'main', ['trip']).review.some((item) => item.kind === 'message')
	).toBe(true);
});

test('unlinked and missing conversations remain available under Other activity', () => {
	const groups = busyGroups(now);
	const run = groups.running.find((item) => item.kind === 'run')!;
	if (run.kind !== 'run') throw new Error('Missing run fixture');
	expect(conversationInbox(groups, 'other-activity', []).running).toContain(run);
	run.run.conversationId = 'removed-topic';
	expect(conversationInbox(groups, 'other-activity', ['trip']).running).toContain(run);
});

test('approval origin takes precedence over agent identity', () => {
	const groups = busyGroups(now);
	const approval: HomeItem = {
		id: 'approval:topic',
		group: 'waiting',
		kind: 'approval',
		at: new Date(now).toISOString(),
		approval: {
			nonce: 'topic',
			view: {
				conversationId: 'trip',
				agentId: 'main',
				agentName: 'agent',
				tool: 'send_email',
				fields: []
			}
		}
	};
	groups.waiting.push(approval);
	expect(inboxConversation(approval, groups)).toBe('trip');
	expect(conversationInbox(groups, 'main', ['trip']).waiting).not.toContain(approval);
	expect(conversationInbox(groups, 'trip', ['trip']).waiting).toContain(approval);
});
