// Serves the connector fixtures until the bot runs MCP servers. Changes last until reload.
import { fixtureDelay, fixtureScenario, type FixtureScenario } from '../../core/fixtures';
import type { ConnectorsApi } from './api';
import { newServer, servers } from './fixtures';
import type { McpServer } from './types';

function failure(scenario: string): Error | null {
	if (scenario === 'error') return new Error("The agent's server didn't answer.");
	if (scenario === 'offline') return new Error("Can't reach the agent right now.");
	if (scenario === 'unsupported') return new Error("Connectors aren't available yet.");
	return null;
}

const summary = ({ snapshotAt, toolList, history, usedBy, ...s }: McpServer) => s;

export function createFixtureConnectorsApi(
	pick: () => FixtureScenario = () => fixtureScenario('connectors')
): ConnectorsApi {
	const added: McpServer[] = [];
	const removed = new Set<string>();
	const changed = new Map<string, McpServer>();
	const all = () =>
		[...servers(Date.now()), ...added]
			.filter((s) => !removed.has(s.id))
			.map((s) => changed.get(s.id) ?? s);
	async function gate() {
		const scenario = pick();
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		return scenario;
	}
	return {
		async list() {
			const scenario = await gate();
			return scenario === 'empty' ? added.map(summary) : all().map(summary);
		},
		async get(id) {
			await gate();
			return all().find((s) => s.id === id) ?? null;
		},
		async acceptTools(id) {
			await fixtureDelay('normal');
			const s = all().find((x) => x.id === id);
			if (!s) throw new Error('That server is gone.');
			const toolList = s.toolList
				.filter((t) => t.change !== 'removed')
				.map(({ name, description }) => ({ name, description }));
			const next: McpServer = {
				...s,
				changed: false,
				tools: toolList.length,
				toolList,
				snapshotAt: new Date().toISOString(),
				history: [
					{
						at: new Date().toISOString(),
						event: `Snapshot of ${toolList.length} tools saved by you.`
					},
					...s.history
				]
			};
			changed.set(id, next);
			return next;
		},
		async action(id, action) {
			await gate();
			const s = all().find((s) => s.id === id);
			if (!s) throw new Error('That server is gone.');
			if (action === 'remove') {
				removed.add(id);
				return { removed: true };
			}
			const next: McpServer = {
				...s,
				enabled: action === 'reconnect',
				status: action === 'reconnect' ? 'connected' : 'signed-out'
			};
			changed.set(id, next);
			return next;
		},
		async begin(url, token) {
			if (token) {
				await gate();
				const s = newServer(Date.now(), url, new URL(url).hostname);
				added.push(s);
				return s;
			}
			await fixtureDelay('normal');
			let host: string;
			try {
				const u = new URL(url);
				if (u.protocol !== 'https:') throw new Error();
				host = u.hostname;
			} catch {
				throw new Error('That isn’t an https:// address.');
			}
			const word = host.replace(/^mcp\./, '').split('.')[0] || 'Server';
			const name = word[0].toUpperCase() + word.slice(1);
			const authUrl = `https://${host}/oauth/authorize?client_id=agent&redirect_uri=http%3A%2F%2Flocalhost%3A7461%2Fcallback&state=q8Zt2`;
			return { name, authUrl };
		},
		async finish(url, redirect) {
			await fixtureDelay('slow');
			if (!/^http:\/\/localhost:7461\/callback\?.*code=/.test(redirect))
				throw new Error('That address has no sign-in code. Copy it again after approving.');
			const { name } = await this.begin(url);
			const s = newServer(Date.now(), url, name);
			added.push(s);
			return s;
		}
	};
}
