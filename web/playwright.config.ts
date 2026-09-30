import { defineConfig } from '@playwright/test';

const HARNESS = 'e2e/harness/vite.config.ts';

export default defineConfig({
	testDir: 'e2e',
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: 'http://localhost:4173',
		viewport: { width: 412, height: 915 },
		deviceScaleFactor: 2.625,
		isMobile: true,
		hasTouch: true,
		browserName: 'chromium',
		// Full Chromium's new headless mode, because headless shell always reports notifications as denied.
		channel: 'chromium'
	},
	webServer: [
		{
			// vite preview serves .svelte-kit/output, which build:proto overwrites, so always rebuild first.
			command: 'bun run build && bun run preview --port 4173 --strictPort',
			timeout: 180_000,
			url: 'http://localhost:4173',
			reuseExistingServer: false
		},
		{
			command: `bunx vite build -c ${HARNESS} && bunx vite preview -c ${HARNESS} --port 4174 --strictPort`,
			timeout: 180_000,
			url: 'http://localhost:4174',
			reuseExistingServer: false
		}
	]
});
