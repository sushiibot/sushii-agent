import type { HomeGroups, HomeItem } from './types';

export const UNASSIGNED_CONVERSATION = 'other-activity';

/** Source context for action requests; scheduled inbox items are independent of chat delivery. */
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
	if (item.kind === 'message' || item.kind === 'alert') return UNASSIGNED_CONVERSATION;
	return 'main';
}
