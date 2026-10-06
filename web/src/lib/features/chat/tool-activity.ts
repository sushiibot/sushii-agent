import type { MessagePart, TurnStep } from './types';

export type ToolKind =
	'read' | 'search' | 'bash' | 'edit' | 'browse' | 'database' | 'agent' | 'other';
export function toolCategory(tool: string): { kind: ToolKind; label: string; key: string } {
	if (tool === 'github_push') return { kind: 'other', label: 'GitHub push', key: tool };
	const name = tool.toLowerCase().split(/\.|__/).at(-1)!;
	let kind: ToolKind = 'other';
	if (/^(read($|_)|cat$)/.test(name)) kind = 'read';
	else if (/(^|_)(search|grep|rg|find)(_|$)/.test(name)) kind = 'search';
	else if (/^(bash|exec|exec_command|execute_command|run_command|shell|write_stdin)$/.test(name))
		kind = 'bash';
	else if (/(^|_)(edit|write|patch|apply_patch)(_|$)/.test(name)) kind = 'edit';
	else if (/(browser|playwright|fetch|browse|web|navigate)/.test(name)) kind = 'browse';
	else if (/(sql|database|query)/.test(name)) kind = 'database';
	else if (/(agent|delegate)/.test(name)) kind = 'agent';
	const labels = {
		read: 'Read',
		search: 'Search',
		bash: 'Bash',
		edit: 'Edit',
		browse: 'Browse',
		database: 'Database',
		agent: 'Agent',
		other: tool.replaceAll('_', ' ')
	};
	return { kind, label: labels[kind], key: kind === 'other' ? tool : kind };
}
export function activityCategories(steps: TurnStep[]) {
	const categories = new Map<string, ReturnType<typeof toolCategory> & { count: number }>();
	for (const step of steps) {
		const category = toolCategory(step.tool);
		const existing = categories.get(category.key);
		if (existing) existing.count++;
		else categories.set(category.key, { ...category, count: 1 });
	}
	return [...categories.values()];
}
export type ActivityPart = MessagePart | { type: 'data-tool-group'; data: TurnStep[] };
/** Keep source indexes for text streaming and stable keys; never hide approvals or failures. */
export function groupToolActivity(parts: MessagePart[]): { part: ActivityPart; index: number }[] {
	const out: { part: ActivityPart; index: number }[] = [];
	let pending: { step: TurnStep; index: number; part: MessagePart }[] = [];
	function flush() {
		if (pending.length > 1)
			out.push({
				part: { type: 'data-tool-group', data: pending.map((p) => p.step) },
				index: pending[0].index
			});
		else if (pending.length) out.push({ part: pending[0].part, index: pending[0].index });
		pending = [];
	}
	parts.forEach((part, index) => {
		let step: TurnStep | undefined;
		if (part.type === 'data-tool' && !part.data.approval && part.data.state !== 'failed')
			step = part.data;
		else if (
			'toolCallId' in part &&
			!part.approval &&
			!['output-denied', 'approval-requested', 'approval-responded'].includes(part.state)
		)
			step = {
				id: part.toolCallId,
				tool: part.type.slice(5),
				label: part.type.slice(5).replaceAll('_', ' '),
				state: part.state === 'output-available' ? 'ok' : 'running',
				input: JSON.stringify(part.input, null, 2),
				output: part.output === undefined ? undefined : JSON.stringify(part.output, null, 2)
			};
		if (step) pending.push({ step, index, part });
		else {
			flush();
			out.push({ part, index });
		}
	});
	flush();
	return out;
}
