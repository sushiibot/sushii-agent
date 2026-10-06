import { expect, test } from 'bun:test';
import { inboxConversation } from './conversation-inbox';
import { busyGroups } from './fixtures';
import type { HomeItem } from './types';

const now = Date.now();

test('scheduled heartbeat messages and alerts are independent of Main chat', () => {
	const groups = busyGroups(now);
	const message = groups.review.find((item) => item.kind === 'message')!;
	const alert = groups.failed.find((item) => item.kind === 'alert')!;
	expect(inboxConversation(message, groups)).toBe('other-activity');
	expect(inboxConversation(alert, groups)).toBe('other-activity');
});

test('recorded run origins remain available as source context', () => {
	const groups = busyGroups(now);
	const run = groups.running.find((item) => item.kind === 'run')!;
	if (run.kind !== 'run') throw new Error('Missing run fixture');
	expect(inboxConversation(run, groups)).toBe('other-activity');
	run.run.conversationId = 'trip';
	expect(inboxConversation(run, groups)).toBe('trip');
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
});
