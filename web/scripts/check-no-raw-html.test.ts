/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { checkSource } from './check-no-raw-html';

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
		const md = 'src/lib/agent/markdown.svelte';
		expect(rules(md, '<Button>Approve</Button>')).toContain('markdown: button');
		expect(rules(md, '<a onclick={go}>x</a>')).toContain('markdown: event handler');
		expect(rules(md, '<div class="bg-approval-surface"></div>')).toContain(
			'markdown: approval surface token'
		);
		expect(rules('src/lib/agent/other.svelte', '<Button>Approve</Button>')).toEqual([]);
	});
});
