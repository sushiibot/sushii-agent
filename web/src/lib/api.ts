export type Me = { login: string; displayName?: string };
export type PushKey = { publicKey: string };
export type Ok = { ok: true };
export type PushTestResult = { sent: number; pruned: number };

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'ApiError';
	}
}

function messageFor(status: number): string {
	if (status === 403) return "This device isn't signed in as the owner. Check Tailscale.";
	if (status >= 500) return 'The agent had a problem. Try again in a moment.';
	return `The request failed (${status}).`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`/api${path}`, {
			method,
			credentials: 'same-origin',
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch {
		throw new ApiError(0, "Can't reach the agent. Check your connection.");
	}
	// The gateway's 403 is a plain-text page, so errors never assume a JSON body.
	if (!res.ok) throw new ApiError(res.status, messageFor(res.status));
	try {
		return (await res.json()) as T;
	} catch {
		throw new ApiError(res.status, 'The agent sent a response the app could not read.');
	}
}

export const api = {
	me: () => request<Me>('GET', '/me'),
	pushKey: () => request<PushKey>('GET', '/push/key'),
	subscribe: (subscription: PushSubscriptionJSON) =>
		request<Ok>('POST', '/push/subscribe', subscription),
	unsubscribe: (endpoint: string) => request<Ok>('DELETE', '/push/subscribe', { endpoint }),
	testPush: () => request<PushTestResult>('POST', '/push/test')
};
