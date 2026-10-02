import { expect, test } from 'bun:test';
import { confirmationOutcome } from './tool-confirmation';
import { applyEvent, createState, mergeHistory } from './reduce';
import { toMessages } from './project';
import type { ChatEnvelope } from '$lib/core/realtime/events';

test('decision words match the workspace confirm parser and cancellation stays distinct', () => {
	for (const answer of ['y', 'yes', 'ok', 'okay', 'approve', 'allow', 'confirm', 'sure'])
		expect(confirmationOutcome({ state: 'answered', answer })).toBe('approved');
	for (const answer of ['n', 'no', 'deny', 'reject', 'cancel', 'decline'])
		expect(confirmationOutcome({ state: 'answered', answer })).toBe('denied');
	expect(confirmationOutcome({ state: 'history' })).toBe('cancelled');
	expect(confirmationOutcome({ state: 'elsewhere', answer: 'Yes' })).toBe('approved-elsewhere');
});

test('typed confirmation attaches to exactly its tool call after execution starts and cold history reload', () => {
	const s = createState();
	const events: ChatEnvelope[] = [
		{ type: 'delta', data: { turnId: 't', offset: 0, text: 'Before' } },
		{
			type: 'ask',
			seq: 1,
			data: {
				key: 'a',
				askId: 'a',
				question: 'Confirm?',
				choices: ['Yes', 'No'],
				toolConfirmation: {
					tool: 'bash',
					input: 'pwd',
					reason: 'Inspect directory',
					toolCallId: 'actual'
				}
			}
		},
		{ type: 'ask_resolved', seq: 2, data: { askId: 'a', answer: 'Yes' } },
		{
			type: 'tool',
			data: { turnId: 't', id: 'actual', name: 'bash', summary: 'pwd', textOffset: 6, ok: true }
		},
		{
			type: 'tool',
			data: { turnId: 't', id: 'other', name: 'bash', summary: 'Later command', textOffset: 6 }
		}
	];
	for (const event of events) applyEvent(s, event, 1);
	const parts = toMessages(s.items).flatMap((m) => m.parts);
	expect(parts.filter((p) => p.type === 'data-ask')).toHaveLength(0);
	const calls = parts.filter((p) => p.type === 'data-tool');
	expect(calls[0]).toMatchObject({
		data: {
			id: 'actual',
			state: 'ok',
			approval: { outcome: 'approved-elsewhere' },
			approvalReason: 'Inspect directory'
		}
	});
	expect(calls[1].data.approval).toBeUndefined();
	const reloaded = createState();
	mergeHistory(reloaded, [
		{
			type: 'ask',
			outboxId: 'a',
			id: 'a',
			at: 'x',
			askId: 'a',
			question: 'Confirm?',
			choices: ['Yes', 'No'],
			answer: 'Yes',
			toolConfirmation: {
				tool: 'bash',
				input: 'pwd',
				reason: 'Inspect directory',
				toolCallId: 'actual'
			}
		},
		{
			type: 'assistant',
			id: 't',
			at: 'x',
			turnId: 't',
			text: 'After',
			tools: [{ id: 'actual', name: 'bash', summary: 'pwd', ok: true }],
			files: []
		}
	]);
	const historyParts = toMessages(reloaded.items).flatMap((m) => m.parts);
	expect(historyParts.filter((p) => p.type === 'data-ask')).toHaveLength(0);
	expect(historyParts[0]).toMatchObject({
		type: 'data-tool',
		data: { id: 'actual', approval: { outcome: 'approved' } }
	});
});

test('reused Pi ids remain scoped to their live turn and cannot steal an old execution', () => {
	const s = createState();
	mergeHistory(s, [
		{
			type: 'assistant',
			id: 'old',
			at: 'x',
			text: 'Old reply',
			tools: [{ id: 'reused', name: 'bash', summary: 'Old command', ok: true }],
			files: []
		}
	]);
	applyEvent(s, { type: 'delta', data: { turnId: 'new', offset: 0, text: 'New commentary' } });
	applyEvent(s, {
		type: 'ask',
		seq: 1,
		data: {
			key: 'new-ask',
			askId: 'new-ask',
			question: 'Allow?',
			choices: ['Yes', 'No'],
			toolConfirmation: { tool: 'bash', input: 'new command', toolCallId: 'reused' }
		}
	});
	let messages = toMessages(s.items);
	expect(messages[0].parts.find((p) => p.type === 'data-tool')).toMatchObject({
		data: { id: 'reused' }
	});
	expect(messages[1].parts.some((p) => p.type === 'data-ask')).toBe(true);
	applyEvent(s, {
		type: 'tool',
		data: { turnId: 'new', id: 'reused', name: 'bash', summary: 'New command' }
	});
	messages = toMessages(s.items);
	const oldCall = messages[0].parts.find((p) => p.type === 'data-tool');
	const newCall = messages[1].parts.find((p) => p.type === 'data-tool');
	expect(oldCall?.data.approval).toBeUndefined();
	expect(newCall?.data.confirmation?.askId).toBe('new-ask');
});

test('partial cold history keeps a confirmation unmatched instead of claiming an earlier reused id', () => {
	const s = createState();
	mergeHistory(s, [
		{
			type: 'assistant',
			id: 'old',
			at: 'x',
			text: 'Old reply',
			tools: [{ id: 'reused', name: 'bash', summary: 'Old command', ok: true }],
			files: []
		},
		{
			type: 'ask',
			outboxId: 'new-ask',
			id: 'new-ask',
			at: 'x',
			askId: 'new-ask',
			question: 'Allow?',
			choices: ['Yes', 'No'],
			answer: 'Yes',
			toolConfirmation: { tool: 'bash', input: 'new command', toolCallId: 'reused' }
		}
	]);
	const parts = toMessages(s.items).flatMap((m) => m.parts);
	expect(parts.filter((p) => p.type === 'data-ask')).toHaveLength(1);
	expect(parts.find((p) => p.type === 'data-tool')?.data.approval).toBeUndefined();
});

test('ambiguous repeated call ids within one history turn keep the confirmation separate', () => {
	const s = createState();
	mergeHistory(s, [
		{
			type: 'ask',
			outboxId: 'ask',
			id: 'ask',
			at: 'x',
			askId: 'ask',
			question: 'Allow?',
			choices: ['Yes', 'No'],
			answer: 'Yes',
			toolConfirmation: { tool: 'bash', input: 'command', toolCallId: 'repeated' }
		},
		{
			type: 'assistant',
			id: 'turn',
			at: 'x',
			text: 'Reply',
			tools: [
				{ id: 'repeated', name: 'bash', summary: 'First', ok: true },
				{ id: 'repeated', name: 'bash', summary: 'Second', ok: true }
			],
			files: []
		}
	]);
	const parts = toMessages(s.items).flatMap((m) => m.parts);
	expect(parts.filter((p) => p.type === 'data-ask')).toHaveLength(1);
	expect(parts.filter((p) => p.type === 'data-tool').every((p) => !p.data.approval)).toBe(true);
});
