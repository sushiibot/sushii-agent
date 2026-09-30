/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { cn, TEXT_SIZES, tv } from './utils';

test('every type-scale token in app.css merges as a font size, not a color', async () => {
	const css = await Bun.file(new URL('../app.css', import.meta.url)).text();
	const tokens = [...css.matchAll(/--text-([a-z]+):/g)].map((m) => m[1]);
	expect(tokens.sort()).toEqual([...TEXT_SIZES].sort());
	for (const t of tokens) {
		expect(cn('text-sm text-primary-foreground', `text-${t}`)).toBe(
			`text-primary-foreground text-${t}`
		);
	}
});

test('shadcn variants keep their color next to a type-scale size', () => {
	const button = tv({
		base: 'text-sm text-primary-foreground',
		variants: { s: { a: 'text-body' } }
	});
	expect(button({ s: 'a' })).toBe('text-primary-foreground text-body');
});
