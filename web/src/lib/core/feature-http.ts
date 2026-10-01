import { HttpError, request, send } from './http';
import { workspaceReadError } from './workspace-error';

/**
 * Requests for a screen whose bot routes may not exist yet: a 404 on a list or an action reads as
 * `unsupported`, the bot's other statuses as for every workspace read.
 */
export function featureHttp(unsupported: string) {
	const fail = (err: unknown) => {
		if (!(err instanceof HttpError)) return err;
		if (err.status === 404) return new HttpError(404, unsupported, err.body);
		// A refused action says why in plain words, such as a bad address.
		const said = (err.body as { error?: unknown } | undefined)?.error;
		if (err.status === 422 && typeof said === 'string') return new HttpError(422, said, err.body);
		return workspaceReadError(err, unsupported);
	};
	return {
		async get<T>(path: string): Promise<T> {
			try {
				return await request<T>('GET', path);
			} catch (err) {
				throw fail(err);
			}
		},
		/** null for a 404: no such item. */
		async find<T>(path: string): Promise<T | null> {
			try {
				return await request<T>('GET', path);
			} catch (err) {
				if (err instanceof HttpError && err.status === 404) return null;
				throw fail(err);
			}
		},
		async post<T>(path: string, body: unknown = {}): Promise<T> {
			try {
				return await request<T>('POST', path, body);
			} catch (err) {
				throw fail(err);
			}
		},
		/** A POST whose answer has no body. */
		async act(path: string, body: unknown = {}): Promise<void> {
			try {
				await send('POST', path, body);
			} catch (err) {
				throw fail(err);
			}
		}
	};
}

export const enc = encodeURIComponent;
