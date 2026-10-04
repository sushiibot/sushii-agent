// Runs in both shipping images, with their real Chromium and agent-browser binaries.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager, localBrowserDriver } from "../src/workspace/browser.ts";

const dir = mkdtempSync("/tmp/browser-preview-smoke-");
const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><html><title>Preview smoke</title><body><h1>Browser preview</h1><button>Continue</button></body></html>", { headers: { "content-type": "text/html" } }) });
const browsers = new BrowserManager(dir, localBrowserDriver(dir));
const binding = browsers.bind("main", () => "smoke");
const browser = binding.tool();
try {
  await browser.execute("open", { args: ["open", `http://127.0.0.1:${page.port}`] }, undefined, undefined, undefined as never);
  let result;
  for (let i = 0; i < 100; i++) {
    result = await browsers.read("main", true);
    if (result.frame) break;
    await Bun.sleep(100);
  }
  if (!result?.frame || result.frame.width !== 1280 || result.frame.height !== 800) throw new Error("Missing 1280 × 800 browser frame");
  const jpeg = Buffer.from(result.frame.data, "base64");
  if (jpeg[0] !== 255 || jpeg[1] !== 216) throw new Error("Frame is not JPEG");
  if (!result.status?.url?.includes(String(page.port))) throw new Error("Initial page URL is missing");
  await binding.finish();
  if ((await browsers.read("main", false)).status?.state !== "ended") throw new Error("Browser did not settle");
  if (JSON.parse(readFileSync(join(dir, "browser-sessions.json"), "utf8")).length) throw new Error("Browser remains owned after cleanup");
  console.log("browser preview stream and cleanup passed");
} finally { await browsers.dispose(); page.stop(true); rmSync(dir, { recursive: true, force: true }); }
