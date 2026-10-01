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
