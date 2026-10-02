import type { ChatMessage } from '$lib/features/chat';
import type { ThreadDetail, ThreadReport } from './types';

/** A thread's chat as shown: Main's brief first, and each memory write under the reply that made it. */
export function threadMessages(
	detail: Pick<ThreadDetail, 'brief' | 'writes'>,
	chat: readonly ChatMessage[]
): ChatMessage[] {
	const brief: ChatMessage = {
		id: 'thread-brief',
		role: 'assistant',
		parts: [{ type: 'data-thread-brief', data: detail.brief }]
	};
	const out: ChatMessage[] = [brief];
	const placed = new Set<string>();
	for (const m of chat) {
		out.push(m);
		const writes = detail.writes.filter((w) => w.after === m.id);
		if (!writes.length) continue;
		for (const w of writes) placed.add(w.id);
		out.push({
			id: `writes-${m.id}`,
			role: 'assistant',
			parts: writes.map((data) => ({ type: 'data-memory-write' as const, data }))
		});
	}
	const rest = detail.writes.filter((w) => !placed.has(w.id) && w.after);
	if (rest.length) {
		out.push({
			id: 'writes-rest',
			role: 'assistant',
			parts: rest.map((data) => ({ type: 'data-memory-write' as const, data }))
		});
	}
	return out;
}

/** Main's chat with the reports of threads closed since it loaded, newest last. */
export function withReports(main: readonly ChatMessage[], reports: readonly ThreadReport[]) {
	if (!reports.length) return main as ChatMessage[];
	return [
		...main,
		...reports
			.filter(
				(r) =>
					!main.some((m) =>
						m.parts.some((p) => p.type === 'text' && p.text.includes(`Thread closed · ${r.title}`))
					)
			)
			.map((data): ChatMessage => ({
				id: `report-${data.sessionId}`,
				role: 'assistant',
				parts: [{ type: 'data-thread-report', data }]
			}))
	];
}
