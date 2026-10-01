import { defineConfig } from "@playwright/test";
import { stackConfig } from "./stack/config.ts";

const { ports, addrs } = stackConfig();

export default defineConfig({
  testDir: "flows",
  // Not *.test.ts: the root `bun test` would pick those up.
  testMatch: "**/*.e2e.ts",
  // One shared stack and database, so flows run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  outputDir: process.env.E2E_PW_OUT ?? "test-results",
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://${addrs.proxy}:${ports.proxy}`,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    browserName: "chromium",
    // Full Chromium's new headless mode, matching web/playwright.config.ts.
    channel: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
