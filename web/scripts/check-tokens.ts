// Fails the lint on colors or text sizes that bypass the tokens in src/app.css (docs/ux-guidelines.md,
// "Tokens" and "Type scale"). The prototype's fake phone chrome is exempt.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Violation {
	file: string;
	line: number;
	rule: string;
}

const PALETTE =
	/-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b/;

const RULES: [RegExp, string][] = [
	[PALETTE, 'palette color'],
	[/\[#[0-9a-fA-F]{3,8}\]/, 'literal color'],
	[/#[0-9a-fA-F]{6}\b/, 'literal color'],
	[/\btext-\[\d+(\.\d+)?px\]/, 'px text size']
];

export function checkSource(file: string, source: string): Violation[] {
	const out: Violation[] = [];
	source.split('\n').forEach((text, i) => {
		for (const [re, rule] of RULES) if (re.test(text)) out.push({ file, line: i + 1, rule });
	});
	return out;
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === 'proto-routes' ? [] : walk(path);
		return name.endsWith('.svelte') ? [path] : [];
	});
}

if (import.meta.main) {
	const root = join(import.meta.dir, '..');
	const violations = walk(join(root, 'src')).flatMap((path) =>
		checkSource(relative(root, path), readFileSync(path, 'utf8'))
	);
	for (const v of violations) console.error(`${v.file}:${v.line}  ${v.rule}`);
	if (violations.length) {
		console.error(`\n${violations.length} token violation(s). Use the tokens in src/app.css.`);
		process.exit(1);
	}
	console.log('colors and text sizes use tokens');
}
