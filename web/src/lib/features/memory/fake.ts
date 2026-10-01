// Serves the Memory fixtures until the bot reads the workspace's memory. Reverts last until reload.
import { fixtureDelay, fixtureScenario } from '$lib/core/fixtures';
import type { MemoryApi } from './api';
import { memoryFiles, memoryWrites } from './fixtures';
import type { MemoryWriteRecord } from './types';

function failure(scenario: string): Error | null {
	if (scenario === 'error') return new Error("The agent's server didn't answer.");
	if (scenario === 'offline') return new Error("Can't reach the agent right now.");
	if (scenario === 'unsupported') return new Error("Memory isn't available yet.");
	return null;
}

export function createFixtureMemoryApi(): MemoryApi {
	const changed = new Map<string, MemoryWriteRecord>();

	async function gate() {
		const scenario = fixtureScenario('memory');
		await fixtureDelay(scenario);
		const err = failure(scenario);
		if (err) throw err;
		return scenario;
	}
	const writes = () => memoryWrites(Date.now()).map((w) => changed.get(w.id) ?? w);
	const hex = () => Math.random().toString(16).slice(2, 9);

	return {
		async overview() {
			const scenario = await gate();
			if (scenario === 'empty') return { files: [], writes: [] };
			return { files: memoryFiles(Date.now()), writes: writes() };
		},
		async file(id) {
			await gate();
			const file = memoryFiles(Date.now()).find((f) => f.id === id);
			return file ? { file, writes: writes().filter((w) => w.fileId === id) } : null;
		},
		async write(id) {
			await gate();
			return writes().find((w) => w.id === id) ?? null;
		},
		async revert(id) {
			await fixtureDelay('normal');
			const w = writes().find((x) => x.id === id);
			if (!w) throw new Error('That change is gone.');
			const next = { ...w, reverted: { at: new Date().toISOString(), commit: hex() } };
			changed.set(id, next);
			return next;
		},
		async restore(id) {
			await fixtureDelay('normal');
			const w = writes().find((x) => x.id === id);
			if (!w) throw new Error('That change is gone.');
			const next = { ...w, reverted: undefined };
			changed.set(id, next);
			return next;
		}
	};
}
