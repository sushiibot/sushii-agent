import { HttpError } from './http';

/**
 * Rewords a failed read the bot answers from the workspace (runs, history, search). The bot's
 * status says why: 501 an older agent, 503 offline, 504 too slow, 502 an answer outside the
 * contract, 400 a stale page cursor.
 */
export function workspaceReadError(err: unknown, unsupported: string): unknown {
	if (!(err instanceof HttpError)) return err;
	const text = readErrorText(err.status, unsupported);
	return text ? new HttpError(err.status, text, err.body) : err;
}

function readErrorText(status: number, unsupported: string): string | null {
	switch (status) {
		case 501:
			return unsupported;
		case 503:
			return "Can't reach the agent right now.";
		case 504:
			return 'The agent took too long to answer. Try again.';
		case 502:
			return "The agent's answer couldn't be read. Try again later.";
		case 400:
			return 'The list changed since it loaded. Reload it to see more.';
		case 404:
			return "This isn't turned on.";
		default:
			return null;
	}
}
