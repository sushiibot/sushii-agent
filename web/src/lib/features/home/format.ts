import type { HomePeek } from './types';

/** The peek sheet's heading, also its accessible name. */
export function peekTitle(peek: HomePeek): string {
	const item = peek.item;
	if (!item) {
		if (peek.result) return 'Done';
		return peek.missing === 'offline' ? "Can't check this now" : 'Already handled';
	}
	switch (item.kind) {
		case 'approval':
			return 'Approval needed';
		case 'ask':
			return 'The agent asks';
		case 'auth':
			return 'Sign-in needed';
		case 'alert':
			return `${item.alert.job} ${item.alert.kind === 'stuck' ? 'is stuck' : 'failed'}`;
		case 'turn':
			return 'Main chat is working';
		case 'run':
			return item.run.title;
		case 'message':
			return `From ${item.message.job}`;
	}
}

/** A message's text as one plain line, for a row title. */
export function messagePreview(text: string): string {
	return text
		.replace(/[*_`~]+/g, '')
		.replace(/^[\s#>-]+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
}
