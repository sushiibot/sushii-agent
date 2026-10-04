// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { ChatSheet } from '$lib/features/chat';
import type { HomeSheet } from '$lib/features/home';
import type { ThreadSheet } from '$lib/features/threads';

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		/** Every sheet a route can open; each feature adds its own union. */
		type SheetId = ChatSheet | HomeSheet | ThreadSheet | 'agent-activity' | 'voice';
		interface PageState {
			sheet?: SheetId;
			/** What the sheet is about, such as a message id. */
			sheetArg?: string;
		}
		// interface Platform {}
	}

	const __APP_VERSION__: string;
}

export {};
