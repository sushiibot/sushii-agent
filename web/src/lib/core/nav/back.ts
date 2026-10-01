import { afterNavigate, goto } from '$app/navigation';

/**
 * The back chevron of a detail screen: back through history when the app navigated here, or
 * to `parent` in place of this entry when it opened cold (a deep link or a push), so Android
 * back from the parent still leaves the app. Call during component init.
 */
export function backTo(parent: string): (e: MouseEvent) => void {
	let inApp = false;
	afterNavigate(({ from }) => {
		inApp = !!from?.url;
	});
	return (e) => {
		e.preventDefault();
		if (inApp) history.back();
		else void goto(parent, { replaceState: true });
	};
}

interface NavigationEntries {
	currentEntry: { index: number } | null;
	entries(): { url: string | null }[];
}

/** Whether the history entry before this one is `path` in this app; false where the browser can't say. */
export function previousPathIs(path: string): boolean {
	const nav = (globalThis as { navigation?: NavigationEntries }).navigation;
	const index = nav?.currentEntry?.index ?? 0;
	if (!nav || index < 1) return false;
	const url = nav.entries()[index - 1]?.url;
	return !!url && new URL(url).origin === location.origin && new URL(url).pathname === path;
}

/** Goes to `path` by stepping back when it is the entry underneath, else in place of this entry. */
export function returnTo(path: string): Promise<void> {
	if (previousPathIs(path)) {
		history.back();
		return Promise.resolve();
	}
	return goto(path, { replaceState: true });
}
