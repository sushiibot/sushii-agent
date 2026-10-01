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
	if (/^\$(app|env)\//.test(specifier) || specifier === '$service-worker') return specifier;
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

/** What a screen or component may take from core: the wire types only. */
const WIRE = `${LIB}core/realtime/events.ts`;
/** The one module the prototype may take from core: the nav table. */
const NAV_TABLE = `${LIB}core/nav/tabs.ts`;

const isLibRoot = (path: string) => /^src\/lib\/[^/]+$/.test(path);
/** A feature's modules that hold state or talk to the server. */
const isStateful = (rest: string) => /(^|\/)([^/]+\.svelte\.ts|api\.ts|fake\.ts)$/.test(rest);

export function checkImport(from: string, target: string | null): string | null {
	if (target === null) return null;
	const special = target.startsWith('$') ? target : null;
	const to = special ? '' : target;
	const toFeature = feature(to);
	const fromFeature = feature(from);

	if (to.startsWith(PROTO) && !from.startsWith(PROTO)) return 'nothing imports proto-routes';
	if (isLibRoot(to) && to !== `${LIB}utils.ts` && !to.startsWith(`${LIB}assets`)) {
		return 'src/lib holds only utils.ts at its root; put the module in a layer';
	}

	// The design system, and anything at the lib root, which nothing may use to route around it.
	if (from.startsWith(`${LIB}ui/`) || isLibRoot(from)) {
		if (special) return `ui may not use ${special}`;
		if (to.startsWith(`${LIB}core/`) || toFeature) return 'ui may not import core or features';
		return null;
	}

	if (from.startsWith(`${LIB}core/`)) {
		if (toFeature) return 'core may not import features';
		if (to.startsWith(`${LIB}ui/`) && to.endsWith('.svelte'))
			return 'core may not import ui components';
		if (special) {
			if (special === '$app/environment' || special.startsWith('$env/')) return null;
			if (
				from.startsWith(`${LIB}core/nav/`) &&
				(special === '$app/navigation' || special === '$app/state')
			)
				return null;
			return `core may not use ${special} outside core/nav`;
		}
		return null;
	}

	if (fromFeature) {
		if (special) return `features may not use ${special}; the route passes values in`;
		if (toFeature && toFeature.name !== fromFeature.name && !isPublic(toFeature.rest)) {
			return `import ${toFeature.name} through its index.ts`;
		}
		if (isPresentational(fromFeature.rest)) {
			// Screens render from props, so the prototype and the harness can mount them bare.
			if (to.startsWith(`${LIB}core/`) && to !== WIRE) {
				return 'screens and components take only the wire types from core';
			}
			if (toFeature && toFeature.name === fromFeature.name && isStateful(toFeature.rest)) {
				return 'screens and components may not import stores or the API';
			}
		}
		return null;
	}

	if (from.startsWith(PROTO)) {
		// The board's own route files drive navigation; its screens and frames take props.
		const routeFile = /\/\+[^/]+$/.test(from);
		if (special && !(routeFile && special.startsWith('$app/'))) {
			return `the prototype may not use ${special}`;
		}
		if (to.startsWith(`${LIB}core/`) && to !== NAV_TABLE) {
			return 'the prototype takes only the nav table from core';
		}
		if (toFeature && !isPublic(toFeature.rest) && toFeature.rest !== 'fixtures.ts') {
			// Until M4 ships threads and the workbench, their mock screens borrow chat's parts.
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
