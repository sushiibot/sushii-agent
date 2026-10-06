import {
	cacheGroup,
	cachedResponse,
	clearResponses,
	forgetResponse,
	saveResponse
} from './storage/offline-cache';
import { offlineBrowsing } from './storage/offline.svelte';

/** status 0 means the request never got an answer (offline, timeout, aborted). */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** The parsed JSON error body, when there was one. */
		readonly body?: unknown
	) {
		super(message);
		this.name = 'HttpError';
	}
	/** Worth sending again as is: no answer, or the server was briefly down. */
	get retryable() {
		return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

export function messageFor(status: number): string {
	if (status === 403) return "This device isn't signed in as the owner. Check Tailscale.";
	if (status >= 500) return 'The agent had a problem. Try again in a moment.';
	return `The request failed (${status}).`;
}

const TIMEOUT_MS = 15_000;
let cacheEpoch = 0;

/** Sends a same-origin /api request; any non-2xx answer throws an HttpError. */
export async function send(
	method: string,
	path: string,
	body?: unknown,
	opts: { signal?: AbortSignal; cachePriority?: number } = {}
): Promise<Response> {
	let res: Response;
	const startedEpoch = cacheEpoch;
	const cacheable = method === 'GET' && cacheGroup(path) !== null;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	try {
		res = await fetch(`/api${path}`, {
			method,
			credentials: 'same-origin',
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
		});
	} catch (err) {
		if (cacheable && !opts.signal?.aborted) {
			const cached = await cachedResponse(path);
			if (cached) {
				offlineBrowsing.unreachable = true;
				return cached;
			}
		}
		if (err instanceof DOMException && err.name === 'TimeoutError') {
			throw new HttpError(0, "The agent didn't answer in time. Try again.");
		}
		throw new HttpError(0, "Can't reach the agent. Check your connection.");
	}
	if (!res.ok) {
		if ([401, 403].includes(res.status)) {
			cacheEpoch++;
			await clearResponses();
			offlineBrowsing.unreachable = false;
		} else if (cacheable && res.status === 404) await forgetResponse(path);
		// The gateway's 403 is a plain-text page, so an error body is only kept when it parses.
		const errorBody: unknown = await res.json().catch(() => undefined);
		throw new HttpError(res.status, messageFor(res.status), errorBody);
	}
	if (cacheable && startedEpoch === cacheEpoch) {
		offlineBrowsing.unreachable = false;
		const text = await res.clone().text();
		try {
			JSON.parse(text);
			await saveResponse(path, text, opts.cachePriority);
		} catch {
			// Invalid responses must not replace a usable snapshot.
		}
	}
	return res;
}

export async function json<T>(res: Response): Promise<T> {
	try {
		return (await res.json()) as T;
	} catch {
		throw new HttpError(res.status, 'The agent sent a response the app could not read.');
	}
}

export async function request<T>(
	method: string,
	path: string,
	body?: unknown,
	opts: { signal?: AbortSignal; cachePriority?: number } = {}
): Promise<T> {
	return json<T>(await send(method, path, body, opts));
}
