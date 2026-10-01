// Fails the app build when fixture data or a fake backend reaches the bundle. They are for /proto,
// the e2e fake backend and `bun dev` with ?fake; in production drk would see made-up runs and alerts.
import type { Plugin } from 'vite';

const FORBIDDEN = [
	/\/src\/lib\/features\/[^/]+\/fake\.ts$/,
	/\/src\/lib\/features\/[^/]+\/fixtures\.ts$/,
	/\/src\/lib\/core\/fixtures\.ts$/,
	/\/src\/lib\/core\/realtime\/fake-transport\.ts$/
];

export function forbiddenModules(ids: Iterable<string>): string[] {
	const out: string[] = [];
	for (const id of ids) {
		const path = id.replace(/\\/g, '/').replace(/\?.*$/, '');
		if (FORBIDDEN.some((re) => re.test(path))) out.push(path);
	}
	return out;
}

interface OutputChunk {
	type: 'chunk' | 'asset';
	fileName: string;
	moduleIds?: readonly string[];
}

/** Each emitted chunk and the forbidden modules in it. */
export function bundleViolations(bundle: Record<string, OutputChunk>): string[] {
	return Object.values(bundle).flatMap((chunk) =>
		chunk.type === 'chunk'
			? forbiddenModules(chunk.moduleIds ?? []).map((id) => `${chunk.fileName}: ${id}`)
			: []
	);
}

export function noFixturesInBundle(): Plugin {
	return {
		name: 'no-fixtures-in-bundle',
		apply: 'build',
		generateBundle(_options, bundle) {
			const found = bundleViolations(bundle as unknown as Record<string, OutputChunk>);
			if (found.length) {
				this.error(`fixtures or a fake backend reached the app build:\n  ${found.join('\n  ')}`);
			}
		}
	};
}
