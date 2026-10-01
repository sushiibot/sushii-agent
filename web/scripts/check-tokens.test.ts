/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { checkSource } from './check-tokens';

const rules = (source: string) => checkSource('a.svelte', source).map((v) => v.rule);

describe('check-tokens', () => {
	test('flags palette and literal colors', () => {
		expect(rules('<p class="text-red-500">x</p>')).toEqual(['palette color']);
		expect(rules('<p class="bg-[#fff]">x</p>')).toEqual(['literal color']);
		expect(rules('<p style="color: #a1b2c3">x</p>')).toEqual(['literal color']);
	});

	test('flags pixel text sizes but not tokens or rem', () => {
		expect(rules('<p class="text-[15px]">x</p>')).toEqual(['px text size']);
		expect(rules('<p class="text-[10.5px]">x</p>')).toEqual(['px text size']);
		expect(rules('<p class="text-body text-[0.8rem] text-sm">x</p>')).toEqual([]);
	});
});
