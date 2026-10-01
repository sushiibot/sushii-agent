import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';

// page.state changes only once the browser has popped the entry, so two closes in one frame
// (Escape and a Close tap) would otherwise go back twice and leave the page.
let closing = false;
let listening = false;
function closeOnce() {
	if (closing) return;
	closing = true;
	if (!listening) {
		listening = true;
		addEventListener('popstate', () => (closing = false));
	}
	history.back();
}

export interface RoutedSheet {
	/** This sheet is the one open. */
	readonly open: boolean;
	/** The argument it was opened with, such as a message id. */
	readonly arg: string | undefined;
	openWith(arg?: string): void;
	close(): void;
}

/**
 * A sheet that lives in a shallow-routing history entry, so Android back closes it. Opening
 * one while another is open replaces that entry instead of stacking a second.
 */
export function routedSheet(id: App.SheetId): RoutedSheet {
	return {
		get open() {
			return page.state.sheet === id;
		},
		get arg() {
			return page.state.sheet === id ? page.state.sheetArg : undefined;
		},
		openWith(arg) {
			const state: App.PageState = arg === undefined ? { sheet: id } : { sheet: id, sheetArg: arg };
			if (page.state.sheet) replaceState('', state);
			else pushState('', state);
		},
		close() {
			if (page.state.sheet === id) closeOnce();
		}
	};
}
