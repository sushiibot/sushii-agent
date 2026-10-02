import { defineConfig } from '@playwright/test';

const HARNESS = 'e2e/harness/vite.config.ts';
const PORT = Number(process.env.PW_PORT ?? 4173);
const HARNESS_PORT = Number(process.env.PW_HARNESS_PORT ?? 4174);

export default defineConfig({
	testDir: 'e2e',
	// Each test owns its browser context and mocked API; large files can share the workers.
	fullyParallel: true,
	workers: process.env.CI ? 4 : undefined,
	forbidOnly: !!process.env.CI,
	// A test that fails and then passes on a retry is reported as flaky, not failed, so a timing hiccup on
	// a busy runner doesn't block the deploy. Locally it fails on the first try, so flakes still show.
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI
		? [['github'], ['json', { outputFile: 'playwright-results.json' }]]
		: 'list',
	use: {
		baseURL: `http://localhost:${PORT}`,
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
			command: `bun run build && bun run preview --port ${PORT} --strictPort`,
			timeout: 180_000,
			url: `http://localhost:${PORT}`,
			reuseExistingServer: false
		},
		{
			command: `bunx vite build -c ${HARNESS} && bunx vite preview -c ${HARNESS} --port ${HARNESS_PORT} --strictPort`,
			timeout: 180_000,
			url: `http://localhost:${HARNESS_PORT}`,
			reuseExistingServer: false
		}
	]
});
