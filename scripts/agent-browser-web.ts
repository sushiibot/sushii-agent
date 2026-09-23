// `agent-browser-web [--proxy] <agent-browser args>`: the same commands as agent-browser, run in a
// Browser Use cloud browser attached over CDP. Without --proxy the session has no residential proxy
// (browser time only); --proxy switches to a proxied session for sites that still block.
// The session is created on first use, reused through a per-task state file, and stopped on close.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://api.browser-use.com/api/v4/browsers";
// Hard cap on the session's lifetime (Browser Use sets a fixed timeoutAt). A session the runner fails
// to stop still ends on its own; a longer task gets a fresh session through the retry below.
const SESSION_TIMEOUT_MIN = 15;

interface WebState {
  id: string;
  cdpUrl: string;
  proxy: boolean;
}

const key = process.env.BROWSER_USE_API_KEY;
const statePath = process.env.AGENT_BROWSER_WEB_STATE;
if (!key || !statePath) {
  console.error("agent-browser-web is not configured on this runner (no Browser Use key).");
  process.exit(1);
}

const args = process.argv.slice(2);
const proxy = args.includes("--proxy");
const abArgs = args.filter((a) => a !== "--proxy");
const headers = { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" };

function readState(): WebState | null {
  try {
    return JSON.parse(readFileSync(statePath!, "utf8")) as WebState;
  } catch {
    return null;
  }
}

async function stop(state: WebState): Promise<void> {
  await fetch(`${API}/${state.id}`, { method: "PATCH", headers, body: JSON.stringify({ action: "stop" }) }).catch(() => {});
  rmSync(statePath!, { force: true });
}

async function create(): Promise<WebState> {
  const res = await fetch(API, {
    method: "POST",
    headers,
    body: JSON.stringify({
      proxyCountryCode: proxy ? "us" : null,
      timeout: SESSION_TIMEOUT_MIN,
      // Tags let the runner find and stop this session if it crashes before the task closes it.
      metadata: { runner: process.env.AGENT_BROWSER_WEB_RUNNER ?? "unknown", task: process.env.AGENT_BROWSER_SESSION ?? "unknown" },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; cdpUrl?: string; detail?: unknown };
  if (!res.ok || !body.id || !body.cdpUrl) {
    console.error(`Browser Use session failed (${res.status}): ${JSON.stringify(body.detail ?? body)}`);
    process.exit(1);
  }
  const state = { id: body.id, cdpUrl: body.cdpUrl, proxy };
  mkdirSync(dirname(statePath!), { recursive: true });
  writeFileSync(statePath!, JSON.stringify(state));
  return state;
}

async function run(state: WebState): Promise<number> {
  const env = {
    ...process.env,
    AGENT_BROWSER_SESSION: `${process.env.AGENT_BROWSER_SESSION ?? "default"}-web`,
    AGENT_BROWSER_STREAM_PORT: process.env.AGENT_BROWSER_WEB_STREAM_PORT ?? "0",
  };
  const proc = Bun.spawn(["agent-browser", "--cdp", state.cdpUrl, ...abArgs], { env, stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

let state = readState();
if (abArgs[0] === "close") {
  const code = state ? await run(state) : 0;
  if (state) await stop(state);
  process.exit(code);
}
if (state && state.proxy !== proxy) {
  // Switching tiers means a different cloud browser; pages and cookies do not carry over.
  await stop(state);
  state = null;
}
state ??= await create();
let code = await run(state);
if (code !== 0 && existsSync(statePath)) {
  // The session may have hit its server-side timeout; retry once on a fresh one.
  const probe = await fetch(`${API}/${state.id}`, { headers }).then((r) => r.json()).catch(() => null);
  if ((probe as { status?: string } | null)?.status !== "active") {
    rmSync(statePath, { force: true });
    code = await run(await create());
  }
}
process.exit(code);
