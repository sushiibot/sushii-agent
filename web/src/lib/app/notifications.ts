import type { ChatItem } from '$lib/chat/reduce';

export interface ShownNotification {
	tag: string;
	close(): void;
}

export interface NotificationSource {
	getNotifications(filter?: { tag?: string }): Promise<readonly ShownNotification[]>;
}

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

/** Closes shown notifications whose tag is in `tags`; resolves to how many it closed. */
export async function closeTagged(source: NotificationSource, tags: ReadonlySet<string>) {
	// One unfiltered read instead of a getNotifications({tag}) per tag: history can hold hundreds.
	const shown = await source.getNotifications();
	let closed = 0;
	for (const n of shown) {
		if (!tags.has(n.tag)) continue;
		n.close();
		closed++;
	}
	return closed;
}

export async function closeShownNotifications(tags: ReadonlySet<string>): Promise<void> {
	if (!('serviceWorker' in navigator)) return;
	// getRegistration() answers at once; `ready` can wait forever before the first install.
	const reg = await navigator.serviceWorker.getRegistration();
	if (reg) await closeTagged(reg, tags);
}
