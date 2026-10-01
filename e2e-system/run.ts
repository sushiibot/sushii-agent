// Real-process e2e runner: builds web/, starts the fake model, proxy, bot and workspace, then runs the
// Playwright flows against them. Usage: bun --no-env-file e2e-system/run.ts [playwright args...]
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { stackConfig } from "./stack/config.ts";

const HERE = import.meta.dir;
const REPO = resolve(HERE, "..");
// Each worktree defaults to its own slot of six ports in 4500-4595, so runs in parallel worktrees
// don't collide. Set in process.env so every child and Playwright resolve the same ports.
if (!process.env["E2E_PORT_BASE"]?.trim()) {
  let h = 0;
  for (const c of REPO) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  process.env["E2E_PORT_BASE"] = String(4500 + (h % 16) * 6);
}
const cfg = stackConfig();
const { ports, addrs } = cfg;
const BUN = process.execPath;
const READY_TIMEOUT_MS = 90_000;

// ── temp dir: data, config, logs and Playwright output for this run ──────────────────────────────
function makeTmp(): string {
  const want = process.env["E2E_TMP_DIR"]?.trim();
  if (!want) return mkdtempSync(join(tmpdir(), "sushii-e2e-"));
  const dir = resolve(want);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`E2E_TMP_DIR ${dir} must be empty or absent`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TMP = makeTmp();
const P = {
  logs: join(TMP, "logs"),
  botData: join(TMP, "bot-data"),
  botHome: join(TMP, "bot-home"),
  config: join(TMP, "config"),
  wsHome: join(TMP, "ws-data", "home"),
  wsState: join(TMP, "ws-data", "state"),
  piAgent: join(TMP, "ws-data", "pi-agent"),
  pwOut: join(TMP, "playwright"),
};
for (const d of Object.values(P)) mkdirSync(d, { recursive: true });
const DB_PATH = join(P.botData, "sushii-agent.db");

/** A Main session from before the web app, which the bot imports once from the workspace (flows/history-import). */
function seedPreWebSession(): void {
  mkdirSync(join(P.piAgent, "chat"), { recursive: true });
  const at = (s: number) => new Date(Date.UTC(2025, 0, 1, 12, 0, s)).toISOString();
  const lines = [
    { type: "session", version: 3, id: "e2e-pre-web", timestamp: at(0), cwd: P.wsHome },
    { type: "message", id: "pre00001", parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "[discord:100000000000000001 2025-01-01 12:00 UTC]\nE2E-PREWEB question from Discord" }] } },
    { type: "message", id: "pre00002", parentId: "pre00001", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "E2E-PREWEB answer from before the app" }], stopReason: "stop" } },
  ];
  writeFileSync(join(P.piAgent, "chat", "2025-01-01T12-00-00-000Z_e2e-pre-web.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
seedPreWebSession();

async function vapidPair() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const bytes = (s: string) => Buffer.from(s, "base64url");
  const pub = Buffer.concat([Buffer.from([4]), bytes(jwk.x!), bytes(jwk.y!)]).toString("base64url");
  return { publicKey: pub, privateKey: jwk.d! };
}

// ── processes ─────────────────────────────────────────────────────────────────────────────────────
interface Proc {
  name: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  child?: ChildProcess;
  exited?: Promise<void>;
}

const procs: Proc[] = [];
const logPath = (name: string) => join(P.logs, `${name}.log`);
const logSize = (name: string) => (existsSync(logPath(name)) ? statSync(logPath(name)).size : 0);
const alive = (p: Proc) => !!p.child && p.child.exitCode === null && p.child.signalCode === null;

function start(p: Proc): void {
  const fd = openSync(logPath(p.name), "a");
  // Own process group, so teardown also reaches anything the process forks.
  const child = spawn(p.cmd[0]!, p.cmd.slice(1), { cwd: p.cwd, env: p.env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  p.child = child;
  p.exited = new Promise((res) => child.once("exit", () => res()));
  if (!procs.includes(p)) procs.push(p);
}

function signal(p: Proc, sig: NodeJS.Signals): void {
  try {
    process.kill(-p.child!.pid!, sig);
  } catch {
    // already gone
  }
}

async function stop(p: Proc, graceMs = 5000): Promise<void> {
  if (!p.child || !alive(p)) return;
  signal(p, "SIGTERM");
  const timedOut = await Promise.race([p.exited!.then(() => false), Bun.sleep(graceMs).then(() => true)]);
  if (timedOut) {
    signal(p, "SIGKILL");
    await p.exited;
  }
}

function tail(name: string, lines = 40): string {
  if (!existsSync(logPath(name))) return "(no log)";
  return readFileSync(logPath(name), "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

async function waitFor(what: string, p: Proc, check: () => Promise<boolean> | boolean): Promise<void> {
  const until = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < until) {
    if (!alive(p)) throw new Error(`${p.name} exited while waiting for ${what}\n--- ${p.name}.log ---\n${tail(p.name)}`);
    if (await Promise.resolve().then(check).catch(() => false)) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}\n--- ${p.name}.log ---\n${tail(p.name)}`);
}

const proxyURL = `http://${addrs.proxy}:${ports.proxy}`;
const botUp = async () => (await fetch(`${proxyURL}/api/me`, { headers: { "Sec-Fetch-Site": "same-origin" } })).status === 200;
const registeredSince = (offset: number) => () => {
  const buf = readFileSync(logPath("bot")).subarray(offset).toString("utf8");
  return buf.includes('"msg":"workspace registered"');
};

// ── preflight: loopback aliases and free ports ────────────────────────────────────────────────────
async function dialFrom(local: string, host: string): Promise<string> {
  const srv = net.createServer();
  const seen = new Promise<string>((res) => srv.once("connection", (s) => { res(s.remoteAddress ?? ""); s.destroy(); }));
  await new Promise<void>((res, rej) => srv.once("error", rej).listen(0, host, () => res()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((res, rej) => {
    const c = net.connect({ host, port, localAddress: local }, () => { c.destroy(); res(); });
    c.once("error", rej);
  });
  const got = await seen;
  srv.close();
  return got;
}

async function portFree(host: string, port: number): Promise<boolean> {
  const srv = net.createServer();
  return new Promise((res) => {
    srv.once("error", () => res(false));
    srv.listen(port, host, () => srv.close(() => res(true)));
  });
}

async function preflight(): Promise<void> {
  for (const local of [addrs.trustedPeer, addrs.untrusted]) {
    let got = "";
    try {
      got = await dialFrom(local, addrs.bot);
    } catch (err) {
      got = String(err);
    }
    if (got !== local) {
      throw new Error(
        `loopback aliases unusable: dialing ${addrs.bot} from ${local} gave "${got}". Linux routes all of 127.0.0.0/8 to lo; ` +
          `on macOS run: sudo ifconfig lo0 alias ${addrs.bot} && sudo ifconfig lo0 alias ${addrs.trustedPeer} && sudo ifconfig lo0 alias ${addrs.untrusted}`,
      );
    }
  }
  const want: [string, string, number][] = [
    ["proxy", addrs.proxy, ports.proxy],
    ["web", addrs.bot, ports.web],
    ["llm", addrs.local, ports.llm],
    // The bot binds these two on every interface.
    ["mcp", "0.0.0.0", ports.mcp],
    ["orch", "0.0.0.0", ports.orch],
    ["control", addrs.local, ports.control],
  ];
  const busy = [];
  for (const [name, host, port] of want) if (!(await portFree(host, port))) busy.push(`${name} ${host}:${port}`);
  if (busy.length) throw new Error(`ports in use: ${busy.join(", ")}. Set E2E_PORT_BASE (or E2E_*_PORT) to a free range.`);
}

// ── control server: what flows use to reach into the stack ────────────────────────────────────────
function controlServer(bot: Proc, llmURL: string) {
  return Bun.serve({
    port: ports.control,
    hostname: addrs.local,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/llm/log") return fetch(`${llmURL}/__log`);
      if (req.method === "POST" && url.pathname === "/db/query") {
        const { sql, params = [] } = (await req.json()) as { sql: string; params?: (string | number | null)[] };
        const db = new Database(DB_PATH, { readonly: true });
        try {
          return Response.json(db.query(sql).all(...params));
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        } finally {
          db.close();
        }
      }
      if (req.method === "POST" && url.pathname === "/bot/restart") {
        await stop(bot);
        if (tornDown) return new Response("tearing down", { status: 503 });
        const offset = logSize("bot");
        start(bot);
        if (url.searchParams.get("wait") === "ready") {
          await waitFor("bot web gateway", bot, botUp);
          await waitFor("workspace re-registration", bot, registeredSince(offset));
        }
        return Response.json({ ok: true, pid: bot.child?.pid });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────
let control: ReturnType<typeof controlServer> | undefined;
let tornDown: Promise<void> | undefined;

// Memoized: the signal handler and main's finally both call it, and both must wait for the same run.
function teardown(): Promise<void> {
  tornDown ??= (async () => {
    await stopForeground();
    await control?.stop(true);
    for (const p of [...procs].reverse()) await stop(p);
  })();
  return tornDown;
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.error(`\n[e2e] ${sig}: tearing down`);
    void teardown().then(() => finish(130));
  });
}

/** The caller's env minus anything that could carry credentials: only what the build and browser need. */
function callerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = /^(PATH|HOME|TMPDIR|LANG|LC_\w+|CI|GITHUB_ACTIONS|DISPLAY|XDG_\w+|E2E_\w+|PLAYWRIGHT_\w+|PW_\w+)$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => keep.test(k) && v !== undefined)) as Record<string, string>;
  return { ...env, ...extra };
}

let foreground: { child: ChildProcess; exited: Promise<void> } | undefined;

function runToExit(cmd: string[], cwd: string, env: Record<string, string>): Promise<number> {
  return new Promise((res, rej) => {
    // Own process group, so teardown can stop it together with the browsers Playwright launched.
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: "inherit", detached: true });
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    foreground = { child, exited };
    child.once("error", rej);
    child.once("exit", (code, sig) => {
      foreground = undefined;
      res(code ?? (sig ? 1 : 0));
    });
  });
}

async function stopForeground(): Promise<void> {
  const fg = foreground;
  if (!fg?.child.pid) return;
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-fg.child.pid!, sig);
    } catch {
      // already gone
    }
  };
  kill("SIGINT");
  if (await Promise.race([fg.exited.then(() => false), Bun.sleep(10_000).then(() => true)])) kill("SIGKILL");
  await fg.exited;
}

async function main(): Promise<number> {
  console.log(`[e2e] temp dir ${TMP}; ports ${ports.proxy}-${ports.control} (E2E_PORT_BASE=${process.env["E2E_PORT_BASE"]})`);
  await preflight();

  if (process.env["E2E_SKIP_BUILD"] !== "1") {
    console.log("[e2e] building web/");
    const code = await runToExit([BUN, "run", "build"], join(REPO, "web"), callerEnv());
    if (code !== 0) throw new Error(`web build failed (${code})`);
  }
  const distDir = join(REPO, "web", "build");
  if (!existsSync(join(distDir, "index.html"))) throw new Error(`${distDir} has no index.html; build web/ first`);

  const vapid = await vapidPair();
  const orchSecret = crypto.randomUUID();
  const ownerDiscordId = "100000000000000001";
  const principals = join(P.config, "principals.json");
  const teams = join(P.config, "teams.json");
  writeFileSync(principals, JSON.stringify({ owner: { owner: true, identities: { discord: ownerDiscordId, web: cfg.ownerLogin } } }));
  writeFileSync(teams, "{}");

  const llmURL = `http://${addrs.local}:${ports.llm}`;
  // Built from scratch: nothing from the caller's shell (tokens, relay keys, OTel) reaches the stack.
  const common = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", E2E_MODEL_ID: cfg.model, TZ: "UTC" };
  const portEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^E2E_/.test(k))) as Record<string, string>;
  const guard = join(HERE, "stack", "net-guard.preload.ts");

  const llm: Proc = { name: "llm", cmd: [BUN, "--no-env-file", join(HERE, "stack", "fake-llm.ts")], cwd: HERE, env: { ...common, ...portEnv, HOME: P.botHome } };
  const proxy: Proc = { name: "proxy", cmd: [BUN, "--no-env-file", join(HERE, "stack", "proxy.ts")], cwd: HERE, env: { ...common, ...portEnv, HOME: P.botHome } };
  const bot: Proc = {
    name: "bot",
    // cwd is the repo: the drizzle migrations folder resolves from it.
    cmd: [BUN, "--no-env-file", "--preload", join(HERE, "stack", "discord-stub.preload.ts"), "--preload", guard, "src/index.ts"],
    cwd: REPO,
    env: {
      ...common,
      HOME: P.botHome,
      NODE_ENV: "production",
      APP_VERSION: "e2e",
      DISCORD_BOT_TOKEN: "e2e-stub",
      OPENAI_API_KEY: "e2e-stub",
      OPENAI_BASE_URL: `${llmURL}/v1`,
      OPENAI_MODEL: cfg.model,
      COMPACTION_MODEL: cfg.model,
      DATABASE_PATH: DB_PATH,
      FEEDBACK_PATH: join(P.botData, "feedback"),
      PRINCIPALS_PATH: principals,
      TEAMS_PATH: teams,
      MCP_BRIDGE_PORT: String(ports.mcp),
      OWNER_DISCORD_ID: ownerDiscordId,
      // Only so file_linear_issue is in the manifest; the flows deny it, so Linear is never called.
      LINEAR_API_KEY: "e2e-stub",
      LINEAR_TEAM_ID: "E2E",
      ORCH_PORT: String(ports.orch),
      ORCH_SECRET: orchSecret,
      DM_WORKSPACE_ENABLED: "true",
      WORKSPACE_PREFERRED_SURFACE: "web",
      OWNER_DM_MODE: "redirect",
      WORKSPACE_TZ: "UTC",
      WEB_PORT: String(ports.web),
      WEB_BIND_ADDR: addrs.bot,
      WEB_TRUSTED_PEERS: addrs.trustedPeer,
      WEB_OWNER_LOGIN: cfg.ownerLogin,
      WEB_DIST_DIR: distDir,
      WEB_FEATURES: "runs,history",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:e2e@example.invalid",
    },
  };
  const ws: Proc = {
    name: "ws",
    cmd: [BUN, "--no-env-file", "--preload", guard, "src/workspace/index.ts"],
    cwd: REPO,
    env: {
      ...common,
      HOME: P.wsHome,
      ORCH_URL: `ws://${addrs.local}:${ports.orch}`,
      ORCH_SECRET: orchSecret,
      OPENAI_API_KEY: "e2e-stub",
      OPENAI_BASE_URL: `${llmURL}/v1`,
      WORKSPACE_PROVIDER: "openrouter",
      WORKSPACE_MODEL: cfg.model,
      WORKSPACE_PRINCIPAL: "owner",
      WORKSPACE_AUTO_MODE: "off",
      WORKSPACE_TZ: "UTC",
      WORKSPACE_HEARTBEAT_EVERY: "off",
      WORKSPACE_STATE_DIR: P.wsState,
      PI_CODING_AGENT_DIR: P.piAgent,
    },
  };

  start(llm);
  await waitFor("fake model", llm, async () => (await fetch(`${llmURL}/__log`)).ok);
  start(proxy);
  start(bot);
  await waitFor("bot web gateway through the proxy", bot, botUp);
  const offset = logSize("bot");
  start(ws);
  await waitFor("workspace registration", bot, async () => {
    if (!alive(ws)) throw new Error(`workspace exited\n--- ws.log ---\n${tail("ws")}`);
    return registeredSince(offset)();
  });
  control = controlServer(bot, llmURL);
  console.log("[e2e] stack ready; running flows");

  return runToExit([join(HERE, "node_modules", ".bin", "playwright"), "test", ...process.argv.slice(2)], HERE, callerEnv({ E2E_TMP: TMP, E2E_WS_HOME: P.wsHome, E2E_PW_OUT: P.pwOut }));
}

function finish(code: number): never {
  if (process.env["E2E_KEEP"] === "1" || code !== 0) console.log(`[e2e] kept ${TMP} (logs in ${P.logs})`);
  else rmSync(TMP, { recursive: true, force: true });
  process.exit(code);
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`[e2e] ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardown();
}
finish(code);
