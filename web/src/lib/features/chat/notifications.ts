import type { ChatItem } from './reduce';

/** Tags of the notifications that Main, on screen, makes redundant. */
export function tagsShownBy(
	items: readonly ChatItem[],
	approvals: readonly { nonce: string }[]
): Set<string> {
	const tags = new Set(['chat']);
	for (const a of approvals) tags.add(`approval:${a.nonce}`);
	for (const i of items) {
		if (i.kind === 'approval') tags.add(`approval:${i.nonce}`);
		else if (i.kind === 'ask' && i.askId) tags.add(`ask:${i.askId}`);
		else if (i.kind === 'auth') tags.add('auth');
	}
	return tags;
}
