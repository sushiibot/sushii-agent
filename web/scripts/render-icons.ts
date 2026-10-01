// Builds UI and install icons from the transparent PNG masters in brand-src/.
// Run from web/ with `bun scripts/render-icons.ts` after replacing a master.
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

const jobs = [
	{ src: 'mark', out: 'static/brand/mark.png', width: 384, height: 240 },
	{ src: 'mascot', out: 'static/brand/mascot.png', width: 640, height: 400 },
	{ src: 'icon', out: 'static/brand/icon.png', width: 256, height: 256 },
	{ src: 'icon', out: 'static/icons/favicon-32.png', width: 32, height: 32 },
	{ src: 'icon', out: 'static/icons/badge-96.png', width: 96, height: 96, monochrome: true },
	{ src: 'icon', out: 'static/icons/icon-192.png', width: 192, height: 192, tile: true },
	{ src: 'icon', out: 'static/icons/icon-512.png', width: 512, height: 512, tile: true },
	{
		src: 'icon',
		out: 'static/icons/icon-maskable-512.png',
		width: 512,
		height: 512,
		maskable: true
	}
];

await mkdir('static/brand', { recursive: true });
await mkdir('static/icons', { recursive: true });
const browser = await chromium.launch();
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	for (const job of jobs) {
		const { src, out, width, height } = job;
		const image = (await readFile(`brand-src/${src}.png`)).toString('base64');
		const maskable = 'maskable' in job && job.maskable;
		const tile = 'tile' in job && job.tile;
		const monochrome = 'monochrome' in job && job.monochrome;
		await page.setViewportSize({ width, height });
		await page.setContent(`
			<style>
				html,body{margin:0;width:100%;height:100%;background:transparent}
				body{display:grid;place-items:center;${tile || maskable ? 'background:#fff3e8;' : ''}${tile ? 'border-radius:22%;' : ''}}
				img{display:block;width:${maskable ? '64%' : tile ? '90%' : '100%'};height:${maskable ? '64%' : tile ? '90%' : '100%'};object-fit:contain;${monochrome ? 'filter:brightness(0) invert(1);' : ''}}
			</style>
			<img src="data:image/png;base64,${image}" alt="" />
		`);
		await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
		await page.screenshot({ path: out, omitBackground: true });
		console.log(out);
	}
} finally {
	await browser.close();
}
