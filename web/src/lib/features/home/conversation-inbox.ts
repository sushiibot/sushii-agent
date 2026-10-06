import type { HomeGroups, HomeItem } from './types';

export const UNASSIGNED_CONVERSATION = 'other-activity';

/** Main-only stream records stay with Main; runs and approvals retain their recorded origin. */
export function inboxConversation(item: HomeItem, groups: HomeGroups): string {
	if (item.kind === 'run') return item.run.conversationId ?? UNASSIGNED_CONVERSATION;
	if (item.kind === 'approval') {
		if (item.approval.view.conversationId) return item.approval.view.conversationId;
		if (item.approval.view.agentId === 'main') return 'main';
		const run = Object.values(groups)
			.flat()
			.find((entry) => entry.kind === 'run' && entry.run.runId === item.approval.view.agentId);
		return run?.kind === 'run'
			? (run.run.conversationId ?? UNASSIGNED_CONVERSATION)
			: UNASSIGNED_CONVERSATION;
	}
	return 'main';
}

export function conversationInbox(groups: HomeGroups, id: string, threadIds: string[]): HomeGroups {
	const belongs = (item: HomeItem) => {
		const origin = inboxConversation(item, groups);
		return id === UNASSIGNED_CONVERSATION
			? origin !== 'main' && !threadIds.includes(origin)
			: origin === id;
	};
	return {
		waiting: groups.waiting.filter(belongs),
		failed: groups.failed.filter(belongs),
		running: groups.running.filter(belongs),
		review: groups.review.filter(belongs)
	};
}
