import { expect, test } from 'bun:test';
import { activityCategories, groupToolActivity, toolCategory } from './tool-activity';
import type { MessagePart, TurnStep } from './types';
const step = (id: string, tool = 'read'): TurnStep => ({
	id,
	tool,
	label: tool,
	state: 'ok',
	input: 'input',
	output: 'output'
});
const call = (id: string, tool = 'read'): MessagePart => ({
	type: 'data-tool',
	data: step(id, tool)
});

test('mixed categories share one compact activity block and retain all details', () => {
	const grouped = groupToolActivity([call('1'), call('2'), call('3', 'bash')]);
	expect(grouped).toEqual([
		{ index: 0, part: { type: 'data-tool-group', data: [step('1'), step('2'), step('3', 'bash')] } }
	]);
	expect(
		activityCategories([step('1'), step('2'), step('3', 'bash')]).map((c) => [c.label, c.count])
	).toEqual([
		['Read', 2],
		['Bash', 1]
	]);
});
test('text, approval decisions, failures and other message parts end an activity stretch', () => {
	const parts: MessagePart[] = [
		call('1'),
		call('2'),
		{ type: 'text', text: 'Between' },
		call('3'),
		{ type: 'data-tool', data: { ...step('4'), approval: { tool: 'read', outcome: 'approved' } } },
		call('5'),
		{ type: 'data-tool', data: { ...step('6'), state: 'failed' } },
		call('7'),
		{ type: 'data-approval', data: { tool: 'bash', outcome: 'pending', nonce: 'n' } },
		call('8'),
		call('9'),
		{ type: 'text', text: 'Last streaming text' }
	];
	const result = groupToolActivity(parts);
	expect(result.map((p) => p.index)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
	expect(result.filter((p) => p.part.type === 'data-tool-group')).toHaveLength(2);
	for (const index of [2, 4, 6, 8, 11])
		expect(result.find((p) => p.index === index)?.part).toBe(parts[index]);
});
test('a lone call remains a direct row; running calls group without changing state', () => {
	const singleton = call('single');
	expect(groupToolActivity([singleton])[0].part).toBe(singleton);
	const running: MessagePart = { type: 'data-tool', data: { ...step('live'), state: 'running' } };
	expect(groupToolActivity([singleton, running])[0].part).toMatchObject({
		type: 'data-tool-group',
		data: [step('single'), { state: 'running', id: 'live' }]
	});
});
test('namespaced tools classify and distinct unknown tools keep distinct counts', () => {
	for (const [name, kind] of [
		['functions.exec_command', 'bash'],
		['mcp__files__read_file', 'read'],
		['search_mail', 'search'],
		['apply_patch', 'edit'],
		['browser_navigate', 'browse'],
		['query_sql', 'database'],
		['delegate_agent', 'agent']
	] as const)
		expect(toolCategory(name).kind).toBe(kind);
	expect(
		activityCategories([
			step('1', 'send_email'),
			step('2', 'calendar_events'),
			step('3', 'send_email')
		]).map((c) => [c.key, c.count])
	).toEqual([
		['send_email', 2],
		['calendar_events', 1]
	]);
});
test('legacy SDK calls group while approval-bearing SDK calls stay outside', () => {
	const legacy: MessagePart = {
		type: 'tool-bash',
		toolCallId: 'sdk',
		state: 'output-available',
		input: { command: 'pwd' },
		output: { result: '/tmp' }
	};
	const approval: MessagePart = {
		...legacy,
		toolCallId: 'approved',
		approval: { id: 'n', approved: true }
	};
	const result = groupToolActivity([legacy, call('2'), approval]);
	expect(result[0].part).toMatchObject({
		type: 'data-tool-group',
		data: [
			{
				id: 'sdk',
				tool: 'bash',
				input: '{\n  "command": "pwd"\n}',
				output: '{\n  "result": "/tmp"\n}'
			},
			step('2')
		]
	});
	expect(result[1].part).toBe(approval);
});
