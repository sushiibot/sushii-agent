// Rasterizes icons-src/*.svg into the PNGs the manifest and service worker reference.
// Run with `bun scripts/render-icons.ts` after changing a source SVG.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const jobs = [
	{ src: 'icons-src/icon.svg', out: 'static/icons/icon-192.png', size: 192 },
	{ src: 'icons-src/icon.svg', out: 'static/icons/icon-512.png', size: 512 },
	{ src: 'icons-src/icon-maskable.svg', out: 'static/icons/icon-maskable-512.png', size: 512 },
	{ src: 'icons-src/badge.svg', out: 'static/icons/badge-96.png', size: 96 }
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { src, out, size } of jobs) {
	const svg = await readFile(src, 'utf8');
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(
		`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
	);
	await page.locator('svg').screenshot({ path: out, omitBackground: true });
	console.log(out);
}
await browser.close();
