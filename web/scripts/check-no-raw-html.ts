// Fails the lint when app code can put a string into the DOM as markup. Svelte's {@html} assigns
// raw strings outside the Trusted Types policy, so it is banned outright rather than reviewed.
import { parse } from 'svelte/compiler';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Violation {
	file: string;
	line: number;
	rule: string;
}

const SINKS: [RegExp, string][] = [
	[/\binnerHTML\b/, 'innerHTML'],
	[/\bouterHTML\b/, 'outerHTML'],
	[/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
	[/\bdocument\s*\.\s*write(ln)?\b/, 'document.write'],
	[/\bcreateContextualFragment\b/, 'createContextualFragment'],
	[/\bDOMParser\b/, 'DOMParser'],
	[/\bsrcdoc\b/, 'srcdoc'],
	[/\bnew\s+Function\b/, 'new Function'],
	[/\beval\s*\(/, 'eval'],
	[/\bsetHTMLUnsafe\b|\bparseHTMLUnsafe\b/, 'setHTMLUnsafe'],
	// Svelte routes a raw snippet's string through its pass-through Trusted Types policy.
	[/\bcreateRawSnippet\b/, 'createRawSnippet'],
	[/\bReflect\s*\.\s*(set|defineProperty)\b/, 'Reflect.set'],
	[/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'string timer'],
	[/\bsetAttribute(NS)?\s*\([^,]*['"`]\s*\+/, 'computed attribute name']
];

// `el['inner' + 'HTML']`, `` el[`outer${x}`] ``: a quoted key that spells part of a markup sink.
const COMPUTED_KEY = /(?:[\w)\]]|\?\.)\s*\[([^\]]*['"`][^\]]*)\]/g;
const SINK_FRAGMENT = /html|inner|outer|adjacent|srcdoc|['"`]doc['"`]/i;

// Folders whose components render agent- or workspace-supplied data.
export const RENDER_DIRS = ['src/lib/features/chat/'];

// Agent text renders here, so it may never emit a control, handler or the approval surface.
export const MARKDOWN = 'src/lib/features/chat/render/markdown.svelte';
// Markdown's one control: an icon button that copies its own code block.
export const COPY_BUTTON = 'src/lib/features/chat/render/code-copy-button.svelte';
const MARKDOWN_IMPORTS = new Set(['../types', './markdown', './code-copy-button.svelte']);

const APPROVAL_LOOKALIKE: [RegExp, string][] = [
	[/approval|data-surface/i, 'markdown: approval surface token'],
	[/Shield\w*|icons\/shield/i, 'markdown: shield icon']
];
const MARKDOWN_BANNED: [RegExp, string][] = [
	[/<button\b|<Button\b/, 'markdown: button'],
	[/<form\b|<input\b|<textarea\b|<select\b/, 'markdown: form control'],
	[/\bon[a-z]+\s*=/, 'markdown: event handler'],
	[/\bimport\s*\(/, 'markdown: dynamic import']
];

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

type AstNode = {
	type?: unknown;
	start?: unknown;
	name?: unknown;
	tag?: unknown;
};

function visit(node: unknown, fn: (n: AstNode & { start: number }) => void): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) visit(child, fn);
		return;
	}
	const n = node as AstNode;
	if (typeof n.type === 'string' && typeof n.start === 'number') {
		fn(n as AstNode & { start: number });
	}
	for (const [key, value] of Object.entries(node)) {
		if (key !== 'parent') visit(value, fn);
	}
}

function templateRules(file: string, source: string): Violation[] {
	const out: Violation[] = [];
	const at = (start: number, rule: string) => out.push({ file, line: lineOf(source, start), rule });
	const markdown = file === MARKDOWN;
	const lookalike = markdown || file === COPY_BUTTON;
	const ast = parse(source, { filename: file, modern: true });
	visit(ast.fragment, (n) => {
		if (n.type === 'HtmlTag') at(n.start, '{@html}');
		if (n.type === 'SvelteElement' && RENDER_DIRS.some((d) => file.startsWith(d))) {
			const tag = n.tag as { type?: string } | string | undefined;
			if (markdown) at(n.start, 'markdown: svelte:element');
			else if (typeof tag === 'object' && tag?.type !== 'Literal') {
				at(n.start, 'render: dynamic svelte:element');
			}
		}
		if (lookalike && n.type === 'SpreadAttribute') at(n.start, 'markdown: spread attributes');
		if (markdown && n.type === 'OnDirective') at(n.start, 'markdown: event handler');
		if (markdown && n.type === 'Attribute' && /^on/i.test(String(n.name))) {
			at(n.start, 'markdown: event handler');
		}
	});
	if (markdown) {
		for (const m of source.matchAll(/\bimport\b[^'"`;]*?['"`]([^'"`]+)['"`]/g)) {
			if (!MARKDOWN_IMPORTS.has(m[1])) at(m.index, `markdown: import ${m[1]}`);
		}
	}
	return out;
}

export function checkSource(file: string, source: string): Violation[] {
	const out: Violation[] = file.endsWith('.svelte') ? templateRules(file, source) : [];
	const lookalike = file === MARKDOWN || file === COPY_BUTTON;
	source.split('\n').forEach((text, i) => {
		const add = (rule: string) => out.push({ file, line: i + 1, rule });
		for (const [re, rule] of SINKS) if (re.test(text)) add(rule);
		for (const m of text.matchAll(COMPUTED_KEY)) {
			if (SINK_FRAGMENT.test(m[1])) add('computed sink access');
		}
		if (lookalike) for (const [re, rule] of APPROVAL_LOOKALIKE) if (re.test(text)) add(rule);
		if (file === MARKDOWN) for (const [re, rule] of MARKDOWN_BANNED) if (re.test(text)) add(rule);
	});
	return out;
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
	const violations = walk(join(root, 'src')).flatMap((path) =>
		checkSource(relative(root, path), readFileSync(path, 'utf8'))
	);
	for (const v of violations) console.error(`${v.file}:${v.line}  ${v.rule}`);
	if (violations.length) {
		console.error(
			`\n${violations.length} raw-HTML violation(s). Render through components instead.`
		);
		process.exit(1);
	}
	console.log('no raw HTML sinks');
}
