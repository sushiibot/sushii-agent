import type { ConversationId } from '$lib/core/realtime/hub.svelte';
import type { ChatItem } from './reduce';

/** The tag of a conversation's reply notifications, as the bot sends them. */
const REPLY_TAG: Record<ConversationId, string> = { main: 'chat' };

/** Tags of the notifications that a conversation, on screen, makes redundant. */
export function tagsShownBy(
	conversation: ConversationId,
	items: readonly ChatItem[],
	approvals: readonly { nonce: string }[]
): Set<string> {
	const tags = new Set([REPLY_TAG[conversation] ?? `chat:${conversation}`]);
	for (const a of approvals) tags.add(`approval:${a.nonce}`);
	for (const i of items) {
		if (i.kind === 'approval') tags.add(`approval:${i.nonce}`);
		else if (i.kind === 'ask' && i.askId) tags.add(`ask:${i.askId}`);
		else if (i.kind === 'auth') tags.add('auth');
	}
	return tags;
}
