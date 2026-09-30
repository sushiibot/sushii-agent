import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';

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
			if (page.state.sheet === id) history.back();
		}
	};
}
