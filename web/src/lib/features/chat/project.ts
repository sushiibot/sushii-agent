import type { ChatMessage, FileRef, MessagePart, Turn } from './types';
import {
	fileUrl,
	isHttpsUrl,
	JOB_NAME_RE,
	UPLOAD_ID_RE,
	type ToolLine,
	type UploadRef
} from '$lib/core/realtime/events';
import type { Attachment, ChatItem, TurnState } from './reduce';

export function formatBytes(n: number): string {
	if (n <= 0) return '';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** A file tile. Only a bot-issued id flagged inline becomes an <img>; a bad id is shown as removed. */
export function fileRef(ref: UploadRef | null, name = ref?.name ?? 'File'): FileRef {
	if (!ref || !UPLOAD_ID_RE.test(ref.id)) {
		return { id: ref?.id ?? name, name, size: '', image: true, removed: true };
	}
	return {
		id: ref.id,
		name: ref.name || name,
		size: formatBytes(ref.bytes),
		image: ref.inline,
		src: ref.inline ? fileUrl(ref.id) : undefined
	};
}

function attachmentRef(a: Attachment, i: number): FileRef {
	if (a.preview) return { id: `preview-${i}`, name: a.name, size: '', image: true, src: a.preview };
	return fileRef(a.ref, a.name);
}

const stepState = { run: 'running', ok: 'ok', err: 'failed' } as const;

export function toTurn(t: TurnState, stopping: boolean): Turn {
	const steps = t.lines.map((l: ToolLine, i) => ({
		id: `${i}`,
		tool: l.name,
		label: l.summary || l.name,
		state: stepState[l.state],
		input: l.summary
	}));
	const running = steps.some((s) => s.state === 'running');
	const elapsed = t.durationMs !== undefined ? formatDuration(t.durationMs) : undefined;
	switch (t.phase) {
		case 'working':
			if (stopping) return { state: 'stopping', steps };
			if (t.label) return { state: 'working', steps, label: t.label };
			if (!steps.length) return { state: 'working', steps, label: 'Working…' };
			return { state: running ? 'working' : 'thinking', steps };
		case 'done':
			return { state: 'done', steps, elapsed };
		case 'stopped':
			return { state: 'stopped', steps, elapsed };
		case 'interrupted':
			return { state: 'stopped', steps, elapsed, label: 'Turn interrupted before it finished' };
	}
}

/** Projects store items onto the prototype's message shape, which the chat components render. */
export function toMessages(
	items: readonly ChatItem[],
	opts: { stopping?: boolean; historyGap?: boolean } = {}
): ChatMessage[] {
	const out: ChatMessage[] = [];
	if (opts.historyGap)
		out.push({ id: 'history-gap', role: 'assistant', parts: [{ type: 'data-history-gap' }] });
	for (const item of items) {
		switch (item.kind) {
			case 'user': {
				const parts: MessagePart[] = [];
				if (item.attachments.length) {
					parts.push({ type: 'data-files', data: { files: item.attachments.map(attachmentRef) } });
				}
				if (item.text) parts.push({ type: 'text', text: item.text });
				out.push({
					id: item.id,
					role: 'user',
					parts,
					delivery: item.delivery
				});
				break;
			}
			case 'assistant': {
				const parts: MessagePart[] = [];
				if (item.turn) parts.push({ type: 'data-turn', data: toTurn(item.turn, !!opts.stopping) });
				// Reply text stays a plain `text` part; the markdown renderer takes it from there.
				if (item.text) parts.push({ type: 'text', text: item.text });
				if (item.files.length) {
					parts.push({ type: 'data-files', data: { files: item.files.map((f) => fileRef(f)) } });
				}
				if (!parts.length) continue;
				out.push({
					id: item.id,
					role: 'assistant',
					parts,
					streaming: item.streaming && !!item.text,
					uploads: item.files
				});
				break;
			}
			case 'ask':
				out.push({
					id: item.id,
					role: 'assistant',
					parts: [
						{
							type: 'data-ask',
							data: {
								askId: item.askId,
								question: item.question,
								choices: item.choices,
								state: item.state,
								answer: item.answer
							}
						}
					]
				});
				break;
			case 'approval':
				out.push({
					id: item.id,
					role: 'assistant',
					parts: [
						{
							type: 'data-approval',
							data: { tool: item.tool, outcome: item.outcome, nonce: item.nonce }
						}
					]
				});
				break;
			case 'divider':
				out.push({
					id: item.id,
					role: 'assistant',
					parts: [{ type: 'data-divider', data: { kind: item.divider, summary: item.summary } }]
				});
				break;
			case 'line':
				out.push({
					id: item.id,
					role: 'assistant',
					parts: [{ type: 'data-line', data: { text: item.text } }]
				});
				break;
			case 'alert': {
				const a = item.alert;
				const open = a.kind !== 'recovered' && JOB_NAME_RE.test(a.job);
				out.push({
					id: item.id,
					role: 'assistant',
					parts: [
						{
							type: 'data-alert',
							data: {
								job: a.job,
								kind: a.kind,
								...(a.error && a.kind !== 'recovered' ? { error: a.error } : {}),
								...(open ? { href: `/?item=${encodeURIComponent(`job:${a.job}`)}` } : {})
							}
						}
					]
				});
				break;
			}
			case 'auth':
				out.push({
					id: item.id,
					role: 'assistant',
					parts: [
						{
							type: 'data-auth',
							data: { instructions: item.instructions, url: item.url, https: isHttpsUrl(item.url) }
						}
					]
				});
				break;
		}
	}
	return out;
}
