// Fails the lint when an import points the wrong way between the layers in src/lib
// (routes → features → core → ui) or reaches into another feature's internals.
import { parse } from 'svelte/compiler';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

export interface Violation {
	file: string;
	specifier: string;
	rule: string;
}

const IMPORTS = [
	// Static imports and re-exports, including `import type` and multi-line lists.
	/(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
	// Side-effect imports.
	/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
	// Dynamic imports.
	/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

/** The script text of a module, or of every <script> in a component. */
function scripts(file: string, source: string): string[] {
	if (!file.endsWith('.svelte')) return [source];
	const ast = parse(source, { filename: file, modern: true });
	return [ast.module, ast.instance].flatMap((s) =>
		s
			? [source.slice((s.content as { start: number }).start, (s.content as { end: number }).end)]
			: []
	);
}

export function specifiers(file: string, source: string): string[] {
	const out = new Set<string>();
	for (const text of scripts(file, source)) {
		for (const re of IMPORTS) for (const m of text.matchAll(re)) out.add(m[1]);
	}
	return [...out];
}

const EXTENSIONS = ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js'];

/** A specifier as a path relative to web/, `$app/...`, or null for a package. */
export function resolveSpecifier(
	from: string,
	specifier: string,
	exists: (path: string) => boolean
): string | null {
	if (specifier.startsWith('$app/')) return specifier;
	let base: string;
	if (specifier === '$lib' || specifier.startsWith('$lib/')) {
		base = join('src/lib', specifier.slice('$lib'.length));
	} else if (specifier.startsWith('.')) {
		base = join(dirname(from), specifier);
	} else {
		return null;
	}
	base = normalize(base).replace(/\\/g, '/');
	const stripped = base.replace(/\.js$/, '');
	for (const candidate of [base, stripped]) {
		for (const ext of EXTENSIONS) {
			if (exists(candidate + ext)) return candidate + ext;
		}
	}
	return base;
}

const LIB = 'src/lib/';
const PROTO = 'src/proto-routes/';
const PROTO_SCREENS = 'src/proto-routes/proto/screens/';

function feature(path: string): { name: string; rest: string } | null {
	const m = path.match(/^src\/lib\/features\/([^/]+)\/(.+)$/);
	return m ? { name: m[1], rest: m[2] } : null;
}

const isPublic = (rest: string) => rest === 'index.ts';
const isPresentational = (rest: string) =>
	/(^|\/)[^/]*-screen\.svelte$/.test(rest) || /^(components|render)\//.test(rest);

export function checkImport(from: string, target: string | null): string | null {
	if (target === null) return null;
	const app = target.startsWith('$app/') ? target : null;
	const to = app ? '' : target;
	const toFeature = feature(to);
	const fromFeature = feature(from);

	if (to.startsWith(PROTO) && !from.startsWith(PROTO)) return 'nothing imports proto-routes';

	if (from.startsWith(`${LIB}ui/`)) {
		if (app) return 'ui may not use $app';
		if (to.startsWith(`${LIB}core/`) || toFeature) return 'ui may not import core or features';
		return null;
	}

	if (from.startsWith(`${LIB}core/`)) {
		if (toFeature) return 'core may not import features';
		if (to.startsWith(`${LIB}ui/`) && to.endsWith('.svelte'))
			return 'core may not import ui components';
		if (app) {
			if (app === '$app/environment') return null;
			if (from.startsWith(`${LIB}core/nav/`) && (app === '$app/navigation' || app === '$app/state'))
				return null;
			return `core may not use ${app} outside core/nav`;
		}
		return null;
	}

	if (fromFeature) {
		if (app) return 'features may not use $app; the route passes values in';
		if (toFeature && toFeature.name !== fromFeature.name && !isPublic(toFeature.rest)) {
			return `import ${toFeature.name} through its index.ts`;
		}
		if (isPresentational(fromFeature.rest)) {
			if (to.startsWith(`${LIB}core/pwa/`)) return 'screens and components may not read core/pwa';
			if (to.startsWith(`${LIB}core/realtime/hub`))
				return 'screens and components may not read the hub';
		}
		return null;
	}

	if (from.startsWith(PROTO)) {
		if (to.startsWith(`${LIB}core/realtime/`) || to.startsWith(`${LIB}core/pwa/`)) {
			return 'the prototype may not open streams or touch the PWA';
		}
		if (toFeature && !isPublic(toFeature.rest) && toFeature.rest !== 'fixtures.ts') {
			const exempt =
				from.startsWith(PROTO_SCREENS) &&
				toFeature.name === 'chat' &&
				/^(components|render)\//.test(toFeature.rest);
			if (!exempt) return `import ${toFeature.name} through its index.ts or fixtures.ts`;
		}
		return null;
	}

	// Routes, hooks and the service worker.
	if (toFeature && !isPublic(toFeature.rest))
		return `import ${toFeature.name} through its index.ts`;
	return null;
}

export function checkFile(
	file: string,
	source: string,
	exists: (path: string) => boolean
): Violation[] {
	return specifiers(file, source).flatMap((specifier) => {
		const rule = checkImport(file, resolveSpecifier(file, specifier, exists));
		return rule ? [{ file, specifier, rule }] : [];
	});
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path);
		return /\.(svelte|ts|js)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
	});
}

if (import.meta.main) {
	const root = join(import.meta.dir, '..');
	const exists = (path: string) =>
		existsSync(join(root, path)) && statSync(join(root, path)).isFile();
	const violations = walk(join(root, 'src')).flatMap((path) =>
		checkFile(relative(root, path).replace(/\\/g, '/'), readFileSync(path, 'utf8'), exists)
	);
	for (const v of violations) console.error(`${v.file}  ${v.specifier}  ${v.rule}`);
	if (violations.length) {
		console.error(`\n${violations.length} boundary violation(s). See web/README.md, Layout.`);
		process.exit(1);
	}
	console.log('imports follow the layers');
}
