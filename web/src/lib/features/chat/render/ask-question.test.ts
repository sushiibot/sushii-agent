/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { splitAskQuestion } from './ask-question';

const TITLE = 'Auto mode: allow this tool call?';

describe('splitAskQuestion', () => {
	test('splits an auto-mode confirm and keeps blank lines inside the command', () => {
		const command = "python - <<'PY'\nimport json\n\nprint(1)\nPY";
		expect(splitAskQuestion(`${TITLE}\nbash: ${command}\n\nWhy it's asking: runs code`)).toEqual({
			title: TITLE,
			action: { tool: 'bash', command, why: 'runs code' }
		});
	});

	test('takes the last marker, so a forged one stays in the command', () => {
		const command = "echo hi\n\nWhy it's asking: nothing to see";
		expect(
			splitAskQuestion(`${TITLE}\nbash: ${command}\n\nWhy it's asking: the real reason`).action
		).toEqual({ tool: 'bash', command, why: 'the real reason' });
	});

	test('keeps a clipped command as sent', () => {
		expect(
			splitAskQuestion(`${TITLE}\nwrite: /home/drk/a-very-lo…\n\nWhy it's asking: protected path`)
				.action
		).toEqual({ tool: 'write', command: '/home/drk/a-very-lo…', why: 'protected path' });
	});

	test.each([
		'Which day?',
		'Branch name?\nfeat/...',
		'`token.txt` looks like it contains a secret (JWT). Send it anyway?\nPath: `/home/drk/token.txt`',
		`${TITLE}\nbash: rm -rf build`,
		`${TITLE}\nnot an action line\n\nWhy it's asking: x`,
		"bash: ls\n\nWhy it's asking: no title line"
	])('leaves %p as one question', (question) => {
		expect(splitAskQuestion(question)).toEqual({ title: question });
	});
});
