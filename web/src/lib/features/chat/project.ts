import { confirmationOutcome } from './tool-confirmation';
import type { AskView, ChatMessage, FileRef, MessagePart, Turn } from './types';
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
		id: l.id ?? `${i}`,
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
			if (!steps.length)
				return {
					state: 'working',
					steps,
					label: t.responseStarted
						? 'Working…'
						: t.modelActivity === 'thinking'
							? 'Thinking…'
							: 'Waiting for the model…'
				};
			return { state: running ? 'working' : 'thinking', steps };
		case 'done':
			return { state: 'done', steps, elapsed };
		case 'stopped':
			return { state: 'stopped', steps, elapsed };
		case 'interrupted':
			return { state: 'stopped', steps, elapsed, label: 'Turn interrupted before it finished' };
	}
}

type Interaction = Extract<ChatItem, { kind: 'ask' | 'approval' }>;
function interactionPart(item: Interaction): MessagePart {
	if (item.kind === 'approval')
		return {
			type: 'data-approval',
			data: { tool: item.tool, outcome: item.outcome, nonce: item.nonce }
		};
	return { type: 'data-ask', data: askView(item) };
}
function askView(item: Extract<ChatItem, { kind: 'ask' }>): AskView {
	return {
		askId: item.askId,
		question: item.question,
		choices: item.choices,
		state: item.state,
		answer: item.answer,
		toolConfirmation: item.toolConfirmation
	};
}

/** Projects store items onto the prototype's message shape, which the chat components render. */
export function toMessages(
	items: readonly ChatItem[],
	opts: { stopping?: boolean; historyGap?: boolean } = {}
): ChatMessage[] {
	const out: ChatMessage[] = [];
	// Associate each approval with its most recent matching call. Unmatched legacy approvals
	// keep their own inline row; no historical relationship is invented.
	const attached = new Map<string, Interaction>();
	const matched = new Set<string>();
	const inline = new Map<string, Interaction[]>();
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex];
		if (item.kind === 'ask' && item.toolConfirmation?.toolCallId) {
			const confirmation = item.toolConfirmation;
			// Live anchors identify the turn. A cold-history ask precedes its durable reply;
			// never borrow an earlier turn's reused Pi id or cross the next user message.
			const nextUser = items.findIndex(
				(candidate, index) => index > itemIndex && candidate.kind === 'user'
			);
			const candidates = item.anchor
				? items.filter(
						(candidate) =>
							candidate.kind === 'assistant' && candidate.id === item.anchor?.assistantId
					)
				: items.slice(itemIndex + 1, nextUser < 0 ? items.length : nextUser);
			const matching = candidates.filter(
				(candidate): candidate is Extract<ChatItem, { kind: 'assistant' }> =>
					candidate.kind === 'assistant' &&
					!!candidate.turn?.lines.some(
						(line) =>
							!line.agentId &&
							line.id === confirmation.toolCallId &&
							line.name === confirmation.tool
					)
			);
			const candidate = matching.length === 1 ? matching[0] : undefined;
			const index =
				candidate?.turn?.lines.findIndex(
					(line) =>
						!line.agentId && line.id === confirmation.toolCallId && line.name === confirmation.tool
				) ?? -1;
			const uniqueLine =
				candidate?.turn?.lines.filter(
					(line) =>
						!line.agentId && line.id === confirmation.toolCallId && line.name === confirmation.tool
				).length === 1;
			if (candidate && index >= 0 && uniqueLine) {
				attached.set(`${candidate.id}:${index}`, item);
				matched.add(item.id);
				continue;
			}
		}
		if (
			(item.kind !== 'ask' && item.kind !== 'approval') ||
			!item.anchor ||
			!items.some((i) => i.kind === 'assistant' && i.id === item.anchor?.assistantId)
		)
			continue;
		matched.add(item.id);
		if (item.kind === 'approval' && item.anchor.callIndex !== undefined)
			attached.set(`${item.anchor.assistantId}:${item.anchor.callIndex}`, item);
		else
			inline.set(item.anchor.assistantId, [...(inline.get(item.anchor.assistantId) ?? []), item]);
	}
	for (let ai = 0; ai < items.length; ai++) {
		const approval = items[ai];
		if (approval.kind !== 'approval' || approval.anchor) continue;
		for (let ti = ai - 1; ti >= 0; ti--) {
			const candidate = items[ti];
			if (candidate.kind === 'user') break;
			if (candidate.kind !== 'assistant' || !candidate.turn) continue;
			const li = candidate.turn.lines.findLastIndex(
				(l, i) => !l.agentId && l.name === approval.tool && !attached.has(`${candidate.id}:${i}`)
			);
			if (li < 0) continue;
			attached.set(`${candidate.id}:${li}`, approval);
			matched.add(approval.id);
			break;
		}
	}
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
				if (item.turn) {
					const turn = toTurn(item.turn, !!opts.stopping);
					const lastPosition = Math.max(
						0,
						...item.turn.lines.filter((l) => !l.agentId).map((l) => l.textOffset ?? 0)
					);
					// The delivered reply contains only the last assistant message. Retain earlier
					// streamed commentary before its calls; the durable answer remains authoritative.
					const text =
						item.activityText && lastPosition > 0
							? item.activityText.endsWith(item.text)
								? item.activityText
								: item.activityText.slice(0, lastPosition) + item.text
							: item.text;
					let offset = 0;
					const interactions = inline.get(item.id) ?? [];
					const insertInteractions = (lineIndex: number) => {
						for (const interaction of interactions) {
							if (interaction.anchor?.lineIndex !== lineIndex) continue;
							const position = Math.max(
								offset,
								Math.min(text.length, interaction.anchor.textOffset)
							);
							if (position > offset)
								parts.push({ type: 'text', text: text.slice(offset, position) });
							parts.push(interactionPart(interaction));
							offset = position;
						}
					};
					for (let i = 0; i < turn.steps.length; i++) {
						insertInteractions(i);
						if (item.turn.lines[i].agentId) continue;
						const position = Math.max(
							offset,
							Math.min(text.length, item.turn.lines[i].textOffset ?? 0)
						);
						if (position > offset) parts.push({ type: 'text', text: text.slice(offset, position) });
						const approval = attached.get(`${item.id}:${i}`);
						parts.push({
							type: 'data-tool',
							data: {
								...turn.steps[i],
								...(approval?.kind === 'approval'
									? {
											approval: {
												tool: approval.tool,
												outcome: approval.outcome,
												nonce: approval.nonce
											}
										}
									: approval?.kind === 'ask' && approval.toolConfirmation
										? {
												approval: {
													tool: approval.toolConfirmation.tool,
													outcome: confirmationOutcome(approval)
												},
												approvalReason: approval.toolConfirmation.reason,
												input: approval.toolConfirmation.input,
												confirmation: askView(approval)
											}
										: {})
							}
						});
						offset = position;
					}
					insertInteractions(turn.steps.length);
					if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) });
					if (turn.state !== 'done')
						parts.push({ type: 'data-turn', data: { ...turn, steps: [] } });
				} else if (item.text) parts.push({ type: 'text', text: item.text });
				if (item.files.length) {
					parts.push({ type: 'data-files', data: { files: item.files.map((f) => fileRef(f)) } });
				}
				if (!parts.length) continue;
				out.push({
					id: item.id,
					role: 'assistant',
					sourceId: item.key ?? item.id.replace(/^h:/, ''),
					turnId: item.turnId,
					parts,
					streaming: item.streaming && !!item.text,
					uploads: item.files
				});
				break;
			}
			case 'ask':
			case 'approval':
				if (matched.has(item.id)) break;
				out.push({ id: item.id, role: 'assistant', parts: [interactionPart(item)] });
				break;
			case 'divider':
				out.push({
					id: item.id,
					role: 'assistant',
					parts: [
						{
							type: 'data-divider',
							data: {
								kind: item.divider,
								summary: item.summary,
								summaryTruncated: item.summaryTruncated,
								memory: item.memory,
								context: item.context,
								initialContext: item.initialContext
							}
						}
					]
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
