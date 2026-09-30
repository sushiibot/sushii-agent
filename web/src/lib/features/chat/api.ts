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

export type HistoryResult = { ok: true; page: HistoryResponse } | { ok: false };

export interface ChatApi {
	history(q: { before?: string; limit: number }): Promise<HistoryResult>;
	postMessage(body: PostMessageBody): Promise<PostMessageResponse>;
	/** Asks the bot to never deliver a posted message. `unknown`: it never stored it. */
	discardMessage(clientId: string): Promise<'discarded' | 'routed' | 'unknown'>;
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

/** The upload ids a message POST was refused for (409 upload_missing), or null for any other failure. */
export function uploadMissingIds(err: unknown): string[] | null {
	if (!(err instanceof HttpError) || err.status !== 409) return null;
	const b = err.body as Partial<PostMessageUploadMissingResponse> | undefined;
	if (b?.error !== 'upload_missing' || !Array.isArray(b.ids)) return null;
	return b.ids.filter((id): id is string => typeof id === 'string');
}

export const httpChatApi: ChatApi = {
	async history({ before, limit }) {
		const q = new URLSearchParams({ limit: String(limit) });
		if (before) q.set('before', before);
		try {
			const res = await send('GET', `/chat/history?${q}`);
			return { ok: true, page: await json<HistoryResponse>(res) };
		} catch {
			return { ok: false };
		}
	},
	async postMessage(body) {
		return json(await send('POST', '/chat/messages', body));
	},
	async discardMessage(clientId) {
		try {
			await send('DELETE', `/chat/messages/${encodeURIComponent(clientId)}`);
			return 'discarded';
		} catch (err) {
			if (err instanceof HttpError && err.status === 409) return 'routed';
			if (err instanceof HttpError && err.status === 404) return 'unknown';
			throw err;
		}
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
					reject(new HttpError(xhr.status, `Upload failed (${xhr.status}).`));
					return;
				}
				try {
					resolve(JSON.parse(xhr.responseText) as UploadResponse);
				} catch {
					reject(new HttpError(xhr.status, 'The upload answer could not be read.'));
				}
			};
			xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new HttpError(0, 'Upload failed.'));
			xhr.send(blob);
		});
	}
};
