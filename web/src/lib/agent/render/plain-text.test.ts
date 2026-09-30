/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './markdown';
import { hasText, messagePlainText, plainText } from './plain-text';
import type { ChatMessage } from '../types';

const text = (md: string) => plainText(parseMarkdown(md, { origin: 'https://agent.sushii.bot' }));

describe('plainText', () => {
	test('drops inline syntax and keeps link text', () => {
		expect(text('**Bold**, _em_, ~~gone~~, `code` and [a link](https://example.com).')).toBe(
			'Bold, em, gone, code and a link.'
		);
	});

	test('separates blocks with a blank line and lists one item per line', () => {
		expect(text('# Title\n\nFirst.\n\n- one\n- two\n\n1. three\n2. four')).toBe(
			'Title\n\nFirst.\n\none\ntwo\n\nthree\nfour'
		);
	});

	test('keeps code verbatim and drops the fence', () => {
		expect(text('Run:\n\n```sh\nbun  test\n  --watch\n```')).toBe('Run:\n\nbun  test\n  --watch');
	});

	test('tables are tab-separated and rules vanish', () => {
		expect(text('| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\nEnd')).toBe('a\tb\n1\t2\n\nEnd');
	});

	test('quotes and hard breaks', () => {
		expect(text('> quoted **text**\n\nline one  \nline two')).toBe(
			'quoted text\n\nline one\nline two'
		);
	});
});

describe('messagePlainText', () => {
	test('your own text copies as typed', () => {
		const m: ChatMessage = {
			id: 'u',
			role: 'user',
			parts: [{ type: 'text', text: '**not bold**' }]
		};
		expect(messagePlainText(m)).toBe('**not bold**');
	});

	test('agent text copies as rendered, and non-text parts are skipped', () => {
		const m: ChatMessage = {
			id: 'a',
			role: 'assistant',
			parts: [
				{ type: 'text', text: 'Booked **Saturday**.' },
				{ type: 'data-line', data: { text: 'ignored' } }
			]
		};
		expect(messagePlainText(m)).toBe('Booked Saturday.');
	});

	test('hasText ignores blank text and non-text parts', () => {
		expect(hasText({ id: 'x', role: 'assistant', parts: [{ type: 'text', text: '  ' }] })).toBe(
			false
		);
		expect(hasText({ id: 'x', role: 'assistant', parts: [{ type: 'data-history-gap' }] })).toBe(
			false
		);
	});
});
