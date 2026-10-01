/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, resolveSpecifier, specifiers } from './check-boundaries';

const FILES = new Set([
	'src/lib/utils.ts',
	'src/lib/ui/button/index.ts',
	'src/lib/ui/shell/types.ts',
	'src/lib/ui/shell/shell.svelte',
	'src/lib/core/http.ts',
	'src/lib/core/pwa/pwa.svelte.ts',
	'src/lib/core/realtime/hub.svelte.ts',
	'src/lib/core/realtime/events.ts',
	'src/lib/core/nav/tabs.ts',
	'src/lib/features/chat/index.ts',
	'src/lib/features/chat/fixtures.ts',
	'src/lib/features/chat/types.ts',
	'src/lib/features/chat/store.svelte.ts',
	'src/lib/features/chat/api.ts',
	'src/lib/core/realtime/transport.ts',
	'src/lib/core/realtime/sse.ts',
	'src/lib/core/nav/sheet.ts',
	'src/lib/core/storage/outbox.ts',
	'src/lib/foo.ts',
	'src/lib/features/chat/components/composer.svelte',
	'src/lib/features/chat/render/plain-text.ts',
	'src/lib/features/home/index.ts',
	'src/lib/features/home/store.svelte.ts',
	'src/lib/features/home/fake.ts',
	'src/proto-routes/proto/flows.ts'
]);
const exists = (path: string) => FILES.has(path);
const rules = (file: string, source: string) => checkFile(file, source, exists).map((v) => v.rule);
const ts = (...lines: string[]) => lines.join('\n');
const svelte = (...lines: string[]) =>
	`<script lang="ts">\n${lines.join('\n')}\n</script>\n<p>x</p>`;

describe('finding imports', () => {
	test('reads every import form, in both scripts of a component', () => {
		const source = [
			'<script lang="ts" module>',
			"\timport type { A } from './a';",
			"\texport { b } from './b';",
			'</script>',
			'<script lang="ts">',
			'\timport {',
			'\t\tc,',
			'\t\ttype D',
			"\t} from './c';",
			"\timport './d.css';",
			"\tconst e = import('./e');",
			'</script>',
			"<p>import x from './not-code'</p>"
		].join('\n');
		expect(specifiers('x.svelte', source).sort()).toEqual(['./a', './b', './c', './d.css', './e']);
		expect(specifiers('x.ts', "export * from './f';\nimport g from '$lib/g';")).toEqual([
			'./f',
			'$lib/g'
		]);
	});

	test('resolves $lib, relative paths, .js suffixes and folder indexes', () => {
		expect(resolveSpecifier('src/lib/ui/button/button.svelte', '$lib/utils.js', exists)).toBe(
			'src/lib/utils.ts'
		);
		expect(resolveSpecifier('src/routes/+page.svelte', '$lib/features/chat', exists)).toBe(
			'src/lib/features/chat/index.ts'
		);
		expect(resolveSpecifier('src/lib/features/chat/store.svelte.ts', './types', exists)).toBe(
			'src/lib/features/chat/types.ts'
		);
		expect(
			resolveSpecifier('src/lib/features/chat/components/composer.svelte', '../types', exists)
		).toBe('src/lib/features/chat/types.ts');
		expect(resolveSpecifier('src/lib/ui/x.svelte', 'bits-ui', exists)).toBeNull();
		expect(resolveSpecifier('src/lib/ui/x.svelte', '$app/state', exists)).toBe('$app/state');
	});
});

describe('the layer rules', () => {
	const imp = (path: string) => svelte(`import x from '${path}';`);

	test('ui imports only ui, utils and packages', () => {
		const file = 'src/lib/ui/screen/screen.svelte';
		expect(
			rules(file, svelte("import { cn } from '$lib/utils';", "import X from 'bits-ui';"))
		).toEqual([]);
		expect(rules(file, imp('$app/state'))).toEqual(['ui may not use $app/state']);
		expect(rules(file, imp('$env/static/public'))).toEqual(['ui may not use $env/static/public']);
		expect(rules(file, imp('$service-worker'))).toEqual(['ui may not use $service-worker']);
		expect(rules(file, imp('$lib/core/realtime/hub.svelte'))).toEqual([
			'ui may not import core or features'
		]);
		expect(rules(file, imp('$lib/features/chat'))).toEqual(['ui may not import core or features']);
	});

	test('the lib root holds only utils.ts, and its files obey the ui rules', () => {
		expect(rules('src/lib/ui/button/button.svelte', imp('$lib/foo'))).toEqual([
			'src/lib holds only utils.ts at its root; put the module in a layer'
		]);
		expect(
			rules('src/lib/foo.ts', ts("import { hub } from '$lib/core/realtime/hub.svelte';"))
		).toEqual(['ui may not import core or features']);
		expect(rules('src/lib/foo.ts', ts("import { page } from '$app/state';"))).toEqual([
			'ui may not use $app/state'
		]);
	});

	test('core never imports features or ui components, and uses $app only for navigation', () => {
		expect(
			rules('src/lib/core/http.ts', ts("import { chatStore } from '$lib/features/chat';"))
		).toEqual(['core may not import features']);
		expect(
			rules('src/lib/core/http.ts', ts("import S from '$lib/ui/shell/shell.svelte';"))
		).toEqual(['core may not import ui components']);
		expect(
			rules('src/lib/core/nav/tabs.ts', ts("import type { NavItem } from '$lib/ui/shell/types';"))
		).toEqual([]);
		expect(
			rules('src/lib/core/pwa/pwa.svelte.ts', ts("import { dev } from '$app/environment';"))
		).toEqual([]);
		expect(rules('src/lib/core/nav/sheet.ts', ts("import { page } from '$app/state';"))).toEqual(
			[]
		);
		expect(rules('src/lib/core/http.ts', ts("import { goto } from '$app/navigation';"))).toEqual([
			'core may not use $app/navigation outside core/nav'
		]);
	});

	test('a feature reaches another only through its index.ts', () => {
		const file = 'src/lib/features/home/store.svelte.ts';
		expect(rules(file, ts("import { chatStore } from '$lib/features/chat';"))).toEqual([]);
		expect(rules(file, ts("import { toMessages } from '$lib/features/chat/types';"))).toEqual([
			'import chat through its index.ts'
		]);
		expect(rules(file, ts("import { page } from '$app/state';"))).toEqual([
			'features may not use $app/state; the route passes values in'
		]);
		expect(rules(file, ts("import { env } from '$env/dynamic/public';"))).toEqual([
			'features may not use $env/dynamic/public; the route passes values in'
		]);
		expect(
			rules(
				'src/lib/features/chat/store.svelte.ts',
				ts("import { hub } from '$lib/core/realtime/hub.svelte';")
			)
		).toEqual([]);
	});

	test('screens, components and render take only the wire types from core, and no stores', () => {
		for (const file of [
			'src/lib/features/chat/chat-screen.svelte',
			'src/lib/features/chat/components/composer.svelte',
			'src/lib/features/chat/render/markdown.svelte'
		]) {
			for (const path of [
				'$lib/core/realtime/hub.svelte',
				'$lib/core/realtime/transport',
				'$lib/core/realtime/sse',
				'$lib/core/nav/sheet',
				'$lib/core/storage/outbox',
				'$lib/core/http',
				'$lib/core/pwa/pwa.svelte'
			]) {
				expect(rules(file, imp(path)), path).toEqual([
					'screens and components take only the wire types from core'
				]);
			}
			expect(rules(file, imp('$lib/features/chat/store.svelte'))).toEqual([
				'screens and components may not import stores or the API'
			]);
			expect(rules(file, imp('$lib/features/chat/api'))).toEqual([
				'screens and components may not import stores or the API'
			]);
			expect(rules(file, imp('$app/navigation'))).toEqual([
				'features may not use $app/navigation; the route passes values in'
			]);
			expect(
				rules(file, svelte("import type { UploadRef } from '$lib/core/realtime/events';"))
			).toEqual([]);
			expect(rules(file, imp('$lib/features/chat/types'))).toEqual([]);
		}
	});

	test('routes use a feature only through its index.ts', () => {
		const file = 'src/routes/+page.svelte';
		expect(
			rules(
				file,
				svelte(
					"import { ChatScreen } from '$lib/features/chat';",
					"import { page } from '$app/state';"
				)
			)
		).toEqual([]);
		expect(rules(file, imp('$lib/features/chat/components/composer.svelte'))).toEqual([
			'import chat through its index.ts'
		]);
	});

	test("only the dev-only ?fake setup reaches a feature's fake", () => {
		const fake = "import { fixtureHomeApi } from '$lib/features/home/fake';";
		expect(rules('src/routes/dev-fakes.ts', ts(fake))).toEqual([]);
		expect(rules('src/routes/+layout.ts', ts(fake))).toEqual(['import home through its index.ts']);
		expect(
			rules('src/routes/dev-fakes.ts', ts("import { x } from '$lib/features/home/store.svelte';"))
		).toEqual(['import home through its index.ts']);
	});

	test('the prototype sees index.ts, fixtures, ui and the nav table, nothing else from core', () => {
		const file = 'src/proto-routes/proto/flows.ts';
		expect(rules(file, ts("import * as c from '$lib/features/chat/fixtures';"))).toEqual([]);
		expect(rules(file, ts("import { tabs } from '$lib/core/nav/tabs';"))).toEqual([]);
		for (const path of [
			'$lib/core/realtime/hub.svelte',
			'$lib/core/pwa/pwa.svelte',
			'$lib/core/nav/sheet',
			'$lib/core/http'
		]) {
			expect(rules(file, ts(`import x from '${path}';`)), path).toEqual([
				'the prototype takes only the nav table from core'
			]);
		}
		expect(rules(file, ts("import { env } from '$env/static/public';"))).toEqual([
			'the prototype may not use $env/static/public'
		]);
		expect(rules('src/proto-routes/proto/components/frame.svelte', imp('$app/state'))).toEqual([
			'the prototype may not use $app/state'
		]);
		expect(rules('src/proto-routes/proto/+page.svelte', imp('$app/navigation'))).toEqual([]);
		expect(rules(file, imp('$lib/features/chat/components/composer.svelte'))).toEqual([
			'import chat through its index.ts or fixtures.ts'
		]);
	});

	test("future screens may borrow chat's components until they graduate", () => {
		const file = 'src/proto-routes/proto/screens/thread-chat.svelte';
		expect(rules(file, imp('$lib/features/chat/components/composer.svelte'))).toEqual([]);
		expect(
			rules(
				file,
				svelte("import { messagePlainText } from '$lib/features/chat/render/plain-text';")
			)
		).toEqual([]);
		expect(rules(file, svelte("import { toMessages } from '$lib/features/chat/project';"))).toEqual(
			['import chat through its index.ts or fixtures.ts']
		);
	});

	test('nothing outside the prototype imports it', () => {
		expect(
			rules(
				'src/lib/features/chat/store.svelte.ts',
				ts("import { flows } from '../../../proto-routes/proto/flows';")
			)
		).toEqual(['nothing imports proto-routes']);
	});
});

test('the real tree has imports to check, and follows the rules', async () => {
	const { checkFile: check } = await import('./check-boundaries');
	const { readFileSync, readdirSync } = await import('node:fs');
	const root = join(import.meta.dir, '..');
	const real = (path: string) =>
		existsSync(join(root, path)) && statSync(join(root, path)).isFile();
	const walk = (dir: string): string[] =>
		readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
			d.isDirectory()
				? walk(`${dir}/${d.name}`)
				: /\.(svelte|ts)$/.test(d.name) && !d.name.endsWith('.test.ts')
					? [`${dir}/${d.name}`]
					: []
		);
	const files = walk('src');
	const found = files.reduce(
		(n, f) => n + specifiers(f, readFileSync(join(root, f), 'utf8')).length,
		0
	);
	expect(found).toBeGreaterThan(300);
	expect(files.flatMap((f) => check(f, readFileSync(join(root, f), 'utf8'), real))).toEqual([]);
});
