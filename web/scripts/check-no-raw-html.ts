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
	[/\bsetHTMLUnsafe\b|\bparseHTMLUnsafe\b/, 'setHTMLUnsafe']
];

// The markdown renderer shows agent text, so it may never emit a control or the approval surface.
const MARKDOWN_FILES = new Set(['src/lib/agent/markdown.svelte']);
const MARKDOWN_BANNED: [RegExp, string][] = [
	[/<button\b|<Button\b/, 'markdown: button'],
	[/<form\b|<input\b|<textarea\b|<select\b/, 'markdown: form control'],
	[/\bon[a-z]+\s*=/, 'markdown: event handler'],
	[/approval|ShieldCheck|data-surface/i, 'markdown: approval surface token']
];

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

function findHtmlTags(node: unknown, found: number[]): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const child of node) findHtmlTags(child, found);
		return;
	}
	const n = node as { type?: unknown; start?: unknown };
	if (n.type === 'HtmlTag' && typeof n.start === 'number') found.push(n.start);
	for (const [key, value] of Object.entries(node)) {
		if (key !== 'parent') findHtmlTags(value, found);
	}
}

export function checkSource(file: string, source: string): Violation[] {
	const out: Violation[] = [];
	if (file.endsWith('.svelte')) {
		const starts: number[] = [];
		findHtmlTags(parse(source, { filename: file, modern: true }), starts);
		for (const start of starts) out.push({ file, line: lineOf(source, start), rule: '{@html}' });
	}
	const lines = source.split('\n');
	lines.forEach((text, i) => {
		for (const [re, rule] of SINKS) if (re.test(text)) out.push({ file, line: i + 1, rule });
		if (MARKDOWN_FILES.has(file)) {
			for (const [re, rule] of MARKDOWN_BANNED) {
				if (re.test(text)) out.push({ file, line: i + 1, rule });
			}
		}
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
