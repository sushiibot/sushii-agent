// Serves the Threads fixtures until the bot runs threads. Changes last until the page reloads.
import { fixtureDelay, fixtureScenario, type FixtureScenario } from '../../core/fixtures';
import type { ThreadsApi } from './api';
import { chatsData, emptyChatsData, threadDetail } from './fixtures';
import type { ChatsData, ThreadDetail, ThreadSummary } from './types';

function failure(scenario: string): Error | null {
	if (scenario === 'error') return new Error("The agent's server didn't answer.");
	if (scenario === 'offline') return new Error("Can't reach the agent right now.");
	if (scenario === 'unsupported') return new Error("Threads aren't available yet.");
	return null;
}

const slug = (title: string) =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 32) || 'thread';

export function createFixtureThreadsApi(
	pick: () => FixtureScenario = () => fixtureScenario('threads')
): ThreadsApi {
	let data: ChatsData | null = null;
	const details = new Map<string, ThreadDetail>();

	async function ready(): Promise<ChatsData> {
		const scenario = pick();
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		data ??= scenario === 'empty' ? emptyChatsData(Date.now()) : chatsData(Date.now());
		return data;
	}

	function update(id: string, change: Partial<ThreadSummary>): ThreadSummary {
		const d = data!;
		const t = d.threads.find((x) => x.id === id);
		if (!t) throw new Error('That thread is gone.');
		const next = { ...t, ...change };
		data = { ...d, threads: d.threads.map((x) => (x.id === id ? next : x)) };
		const detail = details.get(id);
		if (detail) details.set(id, { ...detail, summary: next });
		return next;
	}

	return {
		async list() {
			return structuredClone(await ready());
		},
		async get(id) {
			const d = await ready();
			if (!d.threads.some((t) => t.id === id)) return null;
			let detail = details.get(id) ?? threadDetail(Date.now(), id);
			if (detail) detail = { ...detail, summary: d.threads.find((t) => t.id === id)! };
			if (!detail) {
				const summary = d.threads.find((t) => t.id === id)!;
				detail = {
					summary,
					brief: { known: [`Started from Main: ${summary.preview}`], open: [], recentFromMain: 0 },
					writes: [],
					history: []
				};
			}
			details.set(id, detail);
			return structuredClone(detail);
		},
		async branch({ title }) {
			const d = await ready();
			let id = slug(title);
			for (let n = 2; d.threads.some((t) => t.id === id); n++) id = `${slug(title)}-${n}`;
			const now = new Date().toISOString();
			const summary: ThreadSummary = {
				id,
				title,
				state: 'idle',
				lastActivity: now,
				preview: 'Started from Main.',
				writes: 0
			};
			data = { ...d, threads: [summary, ...d.threads] };
			details.set(id, {
				summary,
				brief: {
					known: [`You started this from a reply in Main about ${title.toLowerCase()}.`],
					open: ['What you want to do next'],
					recentFromMain: 4
				},
				writes: [],
				history: [
					{
						type: 'assistant',
						id: `${id}-a0`,
						at: now,
						text: `Picking up ${title} here. Main stays for everything else.`,
						tools: [],
						files: []
					}
				]
			});
			return summary;
		},
		async close(id) {
			await ready();
			const t = update(id, {
				state: 'archived',
				archived: { at: new Date().toISOString(), by: 'you' }
			});
			return t;
		},
		async rename(id, title) {
			await ready();
			const name = title.trim();
			if (!name || name.length > 120) throw new Error('Use a name between 1 and 120 characters.');
			return update(id, { title: name });
		},
		async reopen(id) {
			await ready();
			return update(id, { state: 'idle', archived: undefined });
		}
	};
}
