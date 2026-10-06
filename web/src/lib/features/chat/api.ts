import type { LocationReply } from './location';
import { HttpError, json, send } from '$lib/core/http';
import type {
	HistoryResponse,
	PostAskBody,
	PostAskResponse,
	PostApprovalBody,
	PostApprovalResponse,
	PostMessageBody,
	PostMessageResponse,
	PostMessageUploadMissingResponse,
	UploadResponse
} from '$lib/core/realtime/events';

export type HistoryResult = { ok: true; page: HistoryResponse; cached?: boolean } | { ok: false };

export interface ChatApi {
	/** Refresh the durable offline snapshot after a live message lands. */
	refreshHistoryCache?(): Promise<void>;
	history(q: { before?: string; limit: number }): Promise<HistoryResult>;
	postMessage(body: PostMessageBody): Promise<PostMessageResponse>;
	/** Asks the bot to never deliver a posted message. `unknown`: it never stored it. */
	discardMessage(clientId: string): Promise<'discarded' | 'routed' | 'unknown'>;
	/** Routes a queued message now: it joins the running turn instead of waiting for it to end. */
	steerMessage(clientId: string): Promise<PostMessageResponse>;
	stop(turnId?: string): Promise<void>;
	command(command: 'new' | 'compact'): Promise<void>;
	answerAsk(askId: string, body: PostAskBody): Promise<PostAskResponse>;
	decide(nonce: string, body: PostApprovalBody): Promise<PostApprovalResponse>;
	location?(nonce: string, reply: LocationReply): Promise<PostApprovalResponse>;
	seen(seq: number): Promise<void>;
	upload(
		blob: Blob,
		meta: { name: string; clientId: string },
		onProgress: (pct: number) => void
	): Promise<UploadResponse>;
}

/** The upload ids a message POST was refused for (409 upload_missing), or null for any other failure. */
export function uploadMissingIds(err: unknown): string[] | null {
	if (!(err instanceof HttpError) || err.status !== 409) return null;
	const b = err.body as Partial<PostMessageUploadMissingResponse> | undefined;
	if (b?.error !== 'upload_missing' || !Array.isArray(b.ids)) return null;
	return b.ids.filter((id): id is string => typeof id === 'string');
}

export function createHttpChatApi(base = '/chat'): ChatApi {
	return {
		async refreshHistoryCache() {
			await send('GET', `${base}/history?limit=40`);
		},
		async history({ before, limit }) {
			const q = new URLSearchParams({ limit: String(limit) });
			if (before) q.set('before', before);
			try {
				const res = await send('GET', `${base}/history?${q}`);
				return {
					ok: true,
					page: await json<HistoryResponse>(res),
					cached: res.headers.has('x-offline-snapshot')
				};
			} catch {
				return { ok: false };
			}
		},
		async postMessage(body) {
			return json(await send('POST', `${base}/messages`, body));
		},
		async discardMessage(clientId) {
			try {
				await send('DELETE', `${base}/messages/${encodeURIComponent(clientId)}`);
				return 'discarded';
			} catch (err) {
				if (err instanceof HttpError && err.status === 409) return 'routed';
				if (err instanceof HttpError && err.status === 404) return 'unknown';
				throw err;
			}
		},
		async steerMessage(clientId) {
			return json(await send('POST', `${base}/messages/${encodeURIComponent(clientId)}/steer`));
		},
		async stop(turnId) {
			await send('POST', `${base}/stop`, turnId ? { turnId } : {});
		},
		async command(command) {
			await send('POST', `${base}/command`, { command });
		},
		async answerAsk(askId, body) {
			return json(await send('POST', `${base}/asks/${encodeURIComponent(askId)}`, body));
		},
		async decide(nonce, body) {
			return json(await send('POST', `${base}/approvals/${encodeURIComponent(nonce)}`, body));
		},
		async location(nonce, reply) {
			return json(await send('POST', `${base}/location/${encodeURIComponent(nonce)}`, reply));
		},
		async seen(seq) {
			await send('POST', `${base}/seen`, { seq });
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
						reject(new HttpError(xhr.status, `Upload failed (${xhr.status}).`));
						return;
					}
					try {
						resolve(JSON.parse(xhr.responseText) as UploadResponse);
					} catch {
						reject(new HttpError(xhr.status, 'The upload answer could not be read.'));
					}
				};
				xhr.onerror =
					xhr.ontimeout =
					xhr.onabort =
						() => reject(new HttpError(0, 'Upload failed.'));
				xhr.send(blob);
			});
		}
	};
}

export const httpChatApi = createHttpChatApi();
