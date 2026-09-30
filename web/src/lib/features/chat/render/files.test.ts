/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { fileHref, fileRefFromUpload, formatBytes, imageSrc } from './files';
import { pendingApproval } from './approvals';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';

describe('file tiles', () => {
	test('an inline raster gets its /f/ src; anything else is a download', () => {
		const png = { id: ID, name: 'a.png', contentType: 'image/png', bytes: 2048, inline: true };
		expect(fileRefFromUpload(png)).toEqual({
			id: ID,
			name: 'a.png',
			size: '2.0 KB',
			image: true,
			src: `/f/${ID}`,
			removed: false
		});
		const svg = { ...png, name: 'x.svg', contentType: 'application/octet-stream', inline: false };
		expect(fileRefFromUpload(svg)).toMatchObject({ image: false, src: undefined });
	});

	test('a malformed id never becomes a URL', () => {
		const bad = { id: '../api/x', name: 'x', contentType: 'image/png', bytes: 1, inline: true };
		expect(fileRefFromUpload(bad)).toMatchObject({ src: undefined, removed: true });
		expect(fileHref('../api/chat/stop')).toBeNull();
		expect(fileHref('..')).toBeNull();
		expect(fileHref('a/b')).toBeNull();
		expect(fileHref(ID)).toBe(`/f/${ID}`);
	});

	test.each([
		'https://tracker.example/p.png',
		'//tracker.example/p.png',
		'/api/me',
		`/f/${ID}x`,
		'javascript:alert(1)'
	])('image src %s is refused', (src) => {
		expect(imageSrc({ id: ID, name: 'a', size: '', image: true, src })).toBeNull();
	});

	test('local previews and the own /f/ path are allowed', () => {
		for (const src of [
			`/f/${ID}`,
			'blob:https://agent.sushii.bot/1',
			'data:image/jpeg;base64,AA'
		]) {
			expect(imageSrc({ id: ID, name: 'a', size: '', image: true, src })).toBe(src);
		}
	});

	test('formatBytes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
		expect(formatBytes(300 * 1024)).toBe('300 KB');
	});
});

describe('approval tray input', () => {
	test('copies the bot view and nonce only', () => {
		const ev = {
			nonce: 'n1',
			view: {
				tool: 'send_email',
				agentId: 'a',
				agentName: 'Main',
				fields: [{ key: 'to', value: 'x@y', kind: 'single' as const, max: 80 }]
			}
		};
		const p = pendingApproval(ev);
		expect(p).toEqual({ nonce: 'n1', view: ev.view });
		expect(p.view.fields[0]).not.toBe(ev.view.fields[0]);
	});
});
