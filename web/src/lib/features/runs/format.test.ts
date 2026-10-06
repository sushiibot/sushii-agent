/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { activityTitle, filterKinds, kindLabel } from './format';

test('Work separates assignments from conversation replies and maintenance', () => {
	expect(filterKinds('work')).toEqual(['job', 'subagent', 'agent']);
	expect(filterKinds('chat')).toEqual(['chat']);
	expect(filterKinds('all')).toBeUndefined();
	expect(kindLabel({ kind: 'subagent', agentName: 'coder' })).toBe('Delegated · coder');
	expect(kindLabel({ kind: 'rotate', agentName: 'main' })).toBe('Context refresh');
});

test('long requests get an honest compact heading without inventing a summary', () => {
	expect(
		activityTitle({
			kind: 'subagent',
			agentName: 'coder',
			title: 'Read AGENTS and replace the image. '.repeat(10)
		})
	).toBe('coder task');
	expect(
		activityTitle({ kind: 'chat', agentName: 'main', title: 'Why did you ask permission?' })
	).toBe('Reply activity');
	expect(activityTitle({ kind: 'agent', agentName: 'coder', title: 'Replace drink photo' })).toBe(
		'Replace drink photo'
	);
});
