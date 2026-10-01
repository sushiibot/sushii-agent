/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
	APPROVAL_SURFACE_FILES,
	checkSource,
	FEATURES_DIR,
	COPY_BUTTON,
	MARKDOWN,
	MESSAGE_ACTIONS
} from './check-no-raw-html';

const rules = (file: string, source: string) => checkSource(file, source).map((v) => v.rule);

describe('check-no-raw-html', () => {
	test('flags {@html} wherever it sits in a template', () => {
		expect(rules('a.svelte', '<p>{@html x}</p>')).toEqual(['{@html}']);
		expect(rules('a.svelte', '{#if a}{#each b as c}<i>{@html c}</i>{/each}{/if}')).toEqual([
			'{@html}'
		]);
		expect(rules('a.svelte', '{#snippet s()}{@html y}{/snippet}')).toEqual(['{@html}']);
	});

	test('does not flag text that merely mentions it', () => {
		expect(rules('a.svelte', '<p>use text, not html</p>')).toEqual([]);
	});

	test('flags DOM string sinks in scripts', () => {
		expect(rules('a.ts', 'el.innerHTML = s;')).toEqual(['innerHTML']);
		expect(rules('a.ts', "el.insertAdjacentHTML('beforeend', s)")).toEqual(['insertAdjacentHTML']);
		expect(rules('a.svelte', '<script>document.write(s)</script>')).toEqual(['document.write']);
		expect(rules('a.ts', 'new DOMParser().parseFromString(s, "text/html")')).toEqual(['DOMParser']);
	});

	test('the markdown renderer may not emit controls or approval tokens', () => {
		const md = MARKDOWN;
		expect(rules(md, '<Button>Approve</Button>')).toContain('markdown: button');
		expect(rules(md, '<a onclick={go}>x</a>')).toContain('markdown: event handler');
		expect(rules(md, '<div class="bg-approval-surface"></div>')).toContain(
			'markdown: approval surface token'
		);
		expect(
			rules('src/lib/features/chat/components/other.svelte', '<Button>Approve</Button>')
		).toEqual([]);
	});

	test("the agent's records may not borrow the approval look", async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		const files = (
			readdirSync(new URL(`../${FEATURES_DIR}`, import.meta.url), { recursive: true }) as string[]
		)
			.filter((f) => /\.(svelte|ts)$/.test(f) && !f.endsWith('.test.ts'))
			.map((f) => `${FEATURES_DIR}${f.replace(/\\/g, '/')}`)
			.filter((f) => !APPROVAL_SURFACE_FILES.has(f));
		for (const dir of ['runs', 'history', 'memory', 'skills', 'connectors', 'briefing', 'threads'])
			expect(
				files.some((f) => f.startsWith(`${FEATURES_DIR}${dir}/`)),
				dir
			).toBe(true);
		for (const file of files) {
			expect(rules(file, read(file)), file).toEqual([]);
			const planted =
				read(file) +
				'\n<span class="bg-approval-surface" data-surface="approval"><ShieldCheck /></span>';
			expect(rules(file, planted), file).toEqual(
				expect.arrayContaining([
					'record: approval token',
					'record: data-surface',
					'record: shield icon'
				])
			);
		}
		expect(rules('src/lib/features/home/components/peek.svelte', '<ApprovalTray />')).toEqual([]);
		expect(
			rules('src/lib/features/some-new-feature/new-screen.svelte', '<ShieldCheck />')
		).toContain('record: shield icon');
		expect(
			rules('src/lib/features/runs/run-detail-screen.svelte', '<p>{run.approvals.length}</p>')
		).toEqual([]);
	});

	test('flags raw snippets, computed sink keys and string code', () => {
		expect(rules('a.ts', "import { createRawSnippet } from 'svelte';")).toEqual([
			'createRawSnippet'
		]);
		expect(rules('a.ts', "el['inner' + 'HTML'] = s;")).toEqual(['computed sink access']);
		expect(rules('a.ts', 'el[`outer${"HTML"}`] = s;')).toEqual(['computed sink access']);
		expect(rules('a.ts', "frame?.['src' + 'doc'] = s;")).toEqual(['computed sink access']);
		expect(rules('a.ts', "el.setAttribute('src' + 'doc', s)")).toEqual(['computed attribute name']);
		expect(rules('a.ts', 'Reflect.set(el, key, s)')).toEqual(['Reflect.set']);
		expect(rules('a.ts', "setTimeout('alert(1)', 0)")).toEqual(['string timer']);
		expect(rules('a.ts', "const x = map['key']; el.dataset['nonce'] = n;")).toEqual([]);
		expect(rules('a.ts', 'setTimeout(() => go(), 0)')).toEqual([]);
	});

	test('render components may not pick their element tag at runtime', () => {
		const tray = 'src/lib/features/chat/components/approval-tray.svelte';
		expect(rules(tray, '<svelte:element this={tag}>x</svelte:element>')).toEqual([
			'render: dynamic svelte:element'
		]);
		expect(rules(tray, '<svelte:element this="h3">x</svelte:element>')).toEqual([]);
		// Deny by default: a new folder is covered without anyone listing it.
		for (const file of [
			'src/routes/x.svelte',
			'src/lib/features/home/peek.svelte',
			'src/lib/ui/x.svelte'
		]) {
			expect(rules(file, '<svelte:element this={tag} />')).toEqual([
				'render: dynamic svelte:element'
			]);
		}
		expect(
			rules('src/lib/ui/badge/badge.svelte', "<svelte:element this={href ? 'a' : 'span'} />")
		).toEqual([]);
		expect(rules('src/lib/ui/x.svelte', "<svelte:element this={href ? 'a' : tag} />")).toEqual([
			'render: dynamic svelte:element'
		]);
	});

	test('markdown: no svelte:element, spreads or handlers in any spelling', () => {
		const md = MARKDOWN;
		expect(rules(md, '<svelte:element this={"button"}>x</svelte:element>')).toContain(
			'markdown: svelte:element'
		);
		expect(rules(md, '<a {...attrs}>x</a>')).toContain('markdown: spread attributes');
		expect(rules(md, '<a on:click={go}>x</a>')).toContain('markdown: event handler');
		expect(rules(md, '<a {onclick}>x</a>')).toContain('markdown: event handler');
		expect(rules(md, '<a onkeydown={go}>x</a>')).toContain('markdown: event handler');
	});

	test('markdown imports only its renderer, types and the Copy button', () => {
		const md = MARKDOWN;
		const script = (body: string) => `<script lang="ts">\n${body}\n</script>`;
		expect(
			rules(
				md,
				script(
					[
						"import type { MdBlock } from '../types';",
						"import CodeCopyButton from './code-copy-button.svelte';",
						"import { parseMarkdown } from './markdown';",
						"import { caretHost, MarkdownStream } from './streaming';"
					].join('\n')
				)
			)
		).toEqual([]);
		for (const icon of ['shield', 'shield-alert', 'shield-check', 'shield-half']) {
			expect(rules(md, script(`import S from '@lucide/svelte/icons/${icon}';`))).toContain(
				'markdown: shield icon'
			);
		}
		expect(rules(md, script("import { ShieldAlert } from '@lucide/svelte';"))).toContain(
			'markdown: shield icon'
		);
		expect(rules(md, script("import Check from '@lucide/svelte/icons/check';"))).toEqual([
			'markdown: import @lucide/svelte/icons/check'
		]);
		expect(rules(md, script("import { Button } from '$lib/ui/button';"))).toContain(
			'markdown: import $lib/ui/button'
		);
		expect(rules(md, script("const m = import('./x');"))).toContain('markdown: dynamic import');
		expect(rules(md, script("import { mount } from 'svelte';"))).toContain(
			'markdown: import svelte'
		);
	});

	test('the Copy button may be a button but never looks like an approval', () => {
		const copy = COPY_BUTTON;
		expect(rules(copy, '<button type="button" onclick={copy}>x</button>')).toEqual([]);
		expect(rules(copy, '<button class="bg-approval">x</button>')).toContain(
			'markdown: approval surface token'
		);
		expect(rules(copy, '<ShieldCheck />')).toContain('markdown: shield icon');
		expect(rules(copy, '<button {...rest}>x</button>')).toContain('markdown: spread attributes');
	});

	test('the message action row may hold buttons but never looks like an approval', () => {
		const row = MESSAGE_ACTIONS;
		expect(rules(row, '<button type="button" onclick={a.onclick}>x</button>')).toEqual([]);
		expect(rules(row, '<div class="border-approval">x</div>')).toContain(
			'markdown: approval surface token'
		);
		expect(rules(row, '<ShieldAlert />')).toContain('markdown: shield icon');
		expect(rules(row, '<button {...rest}>x</button>')).toContain('markdown: spread attributes');
	});

	test('the real source tree is clean', async () => {
		const { readFileSync } = await import('node:fs');
		for (const file of [
			MARKDOWN,
			COPY_BUTTON,
			MESSAGE_ACTIONS,
			'src/lib/features/chat/components/approval-tray.svelte'
		]) {
			expect(
				checkSource(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
			).toEqual([]);
		}
	});

	test('violations planted in the real render files fail at their paths', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		expect(rules(MARKDOWN, read(MARKDOWN) + '\n<button onclick={go}>Approve</button>')).toEqual(
			expect.arrayContaining(['markdown: button', 'markdown: event handler'])
		);
		expect(rules(COPY_BUTTON, read(COPY_BUTTON) + '\n<span class="bg-approval"></span>')).toContain(
			'markdown: approval surface token'
		);
		expect(
			rules(MESSAGE_ACTIONS, read(MESSAGE_ACTIONS) + '\n<span class="text-approval"></span>')
		).toContain('markdown: approval surface token');
		const files = (
			readdirSync(new URL('../src/lib', import.meta.url), { recursive: true }) as string[]
		)
			.filter((f) => f.endsWith('.svelte'))
			.map((f) => `src/lib/${f.replace(/\\/g, '/')}`);
		expect(files.length).toBeGreaterThan(40);
		for (const file of files) {
			const planted = read(file) + '\n<svelte:element this={tag}>x</svelte:element>{@html x}';
			expect(rules(file, planted)).toEqual(
				expect.arrayContaining([
					file === MARKDOWN ? 'markdown: svelte:element' : 'render: dynamic svelte:element',
					'{@html}'
				])
			);
		}
	});
});
