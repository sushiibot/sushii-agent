import type {
	HistoryOfflineResponse,
	HistoryResetResponse,
	HistoryResponse,
	HistoryUnsupportedResponse,
	PostAskBody,
	PostAskResponse,
	PostApprovalBody,
	PostApprovalResponse,
	PostMessageBody,
	PostMessageResponse,
	PostMessageUploadMissingResponse,
	UploadResponse
} from './events';

/** status 0 means the request never got an answer (offline, timeout, aborted). */
export class ChatHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** The parsed JSON error body, when there was one. */
		readonly body?: unknown
	) {
		super(message);
		this.name = 'ChatHttpError';
	}
	/** Worth sending again as is: no answer, or the server was briefly down. */
	get retryable() {
		return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

export type HistoryFailure = 'offline' | 'unsupported' | 'reset' | 'error';

export type HistoryResult =
	{ ok: true; page: HistoryResponse } | { ok: false; reason: HistoryFailure };

export interface ChatApi {
	history(q: { before?: string; limit: number }): Promise<HistoryResult>;
	postMessage(body: PostMessageBody): Promise<PostMessageResponse>;
	stop(turnId?: string): Promise<void>;
	command(command: 'new' | 'compact'): Promise<void>;
	answerAsk(askId: string, body: PostAskBody): Promise<PostAskResponse>;
	decide(nonce: string, body: PostApprovalBody): Promise<PostApprovalResponse>;
	seen(seq: number): Promise<void>;
	upload(
		blob: Blob,
		meta: { name: string; clientId: string },
		onProgress: (pct: number) => void
	): Promise<UploadResponse>;
}

const TIMEOUT_MS = 15_000;

async function send(method: string, path: string, body?: unknown): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(`/api${path}`, {
			method,
			credentials: 'same-origin',
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch {
		throw new ChatHttpError(0, "Can't reach the agent.");
	}
	if (!res.ok) {
		const body: unknown = await res.json().catch(() => undefined);
		throw new ChatHttpError(res.status, `The agent answered ${res.status}.`, body);
	}
	return res;
}

type HistoryErrorBody = Partial<
	HistoryOfflineResponse & HistoryUnsupportedResponse & HistoryResetResponse
>;

/** Known statuses decide; a body flag only names the reason when the status doesn't. */
export function historyFailure(status: number, body: unknown): HistoryFailure {
	const byStatus = ({ 503: 'offline', 501: 'unsupported', 409: 'reset' } as const)[status];
	if (byStatus) return byStatus;
	const b = (typeof body === 'object' && body !== null ? body : {}) as HistoryErrorBody;
	if (b.reset === true) return 'reset';
	if (b.unsupported === true) return 'unsupported';
	if (b.offline === true) return 'offline';
	return 'error';
}

/** The upload ids a message POST was refused for (409 upload_missing), or null for any other failure. */
export function uploadMissingIds(err: unknown): string[] | null {
	if (!(err instanceof ChatHttpError) || err.status !== 409) return null;
	const b = err.body as Partial<PostMessageUploadMissingResponse> | undefined;
	if (b?.error !== 'upload_missing' || !Array.isArray(b.ids)) return null;
	return b.ids.filter((id): id is string => typeof id === 'string');
}

async function json<T>(res: Response): Promise<T> {
	try {
		return (await res.json()) as T;
	} catch {
		throw new ChatHttpError(res.status, 'The agent sent a response the app could not read.');
	}
}

export const httpChatApi: ChatApi = {
	async history({ before, limit }) {
		const q = new URLSearchParams({ limit: String(limit) });
		if (before) q.set('before', before);
		try {
			const res = await send('GET', `/chat/history?${q}`);
			return { ok: true, page: await json<HistoryResponse>(res) };
		} catch (err) {
			const e = err instanceof ChatHttpError ? err : new ChatHttpError(0, String(err));
			return { ok: false, reason: historyFailure(e.status, e.body) };
		}
	},
	async postMessage(body) {
		return json(await send('POST', '/chat/messages', body));
	},
	async stop(turnId) {
		await send('POST', '/chat/stop', turnId ? { turnId } : {});
	},
	async command(command) {
		await send('POST', '/chat/command', { command });
	},
	async answerAsk(askId, body) {
		return json(await send('POST', `/chat/asks/${encodeURIComponent(askId)}`, body));
	},
	async decide(nonce, body) {
		return json(await send('POST', `/chat/approvals/${encodeURIComponent(nonce)}`, body));
	},
	async seen(seq) {
		await send('POST', '/chat/seen', { seq });
	},
	upload(blob, meta, onProgress) {
		// XHR because fetch still reports no upload progress.
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', '/api/uploads');
			xhr.timeout = 120_000;
			xhr.setRequestHeader('content-type', blob.type || 'application/octet-stream');
			xhr.setRequestHeader('x-upload-name', encodeURIComponent(meta.name));
			xhr.setRequestHeader('x-client-id', meta.clientId);
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
			};
			xhr.onload = () => {
				if (xhr.status < 200 || xhr.status >= 300) {
					reject(new ChatHttpError(xhr.status, `Upload failed (${xhr.status}).`));
					return;
				}
				try {
					resolve(JSON.parse(xhr.responseText) as UploadResponse);
				} catch {
					reject(new ChatHttpError(xhr.status, 'The upload answer could not be read.'));
				}
			};
			xhr.onerror =
				xhr.ontimeout =
				xhr.onabort =
					() => reject(new ChatHttpError(0, 'Upload failed.'));
			xhr.send(blob);
		});
	}
};
