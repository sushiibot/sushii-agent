export interface ShownNotification {
	tag: string;
	close(): void;
}

export interface NotificationSource {
	getNotifications(filter?: { tag?: string }): Promise<readonly ShownNotification[]>;
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
