import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BROWSER_READ, browserReadParams, browserFrame, type BrowserFrame, type BrowserReadResult, type BrowserStatus } from "../orchestration/browserContracts.ts";
import { buildAgentEnv } from "../agentRuntime/agentEnv.ts";
import { getLogger } from "../logger.ts";

const log = getLogger("workspace.browser");
const SESSION_RE = /^sushii-[a-f0-9-]{36}$/;
const ACTIONS = new Set(["open", "snapshot", "click", "dblclick", "fill", "type", "press", "scroll", "select", "check", "uncheck", "hover", "get", "is", "find", "wait", "screenshot", "tab", "back", "forward", "reload", "eval", "download", "dialog", "read", "close"]);
const LABELS: Record<string, string> = { open: "Opening page", click: "Clicking", dblclick: "Clicking", fill: "Filling a field", type: "Typing", press: "Pressing a key", scroll: "Scrolling", screenshot: "Taking a screenshot", snapshot: "Reading page", get: "Reading page", read: "Reading page", wait: "Waiting for page", close: "Closing browser" };

export interface BrowserDriver {
  run(session: string, args: string[], signal?: AbortSignal): Promise<string>;
  connect(port: number): WebSocket;
}

export function localBrowserDriver(home: string): BrowserDriver {
  return {
    async run(session, args, signal) {
      const env = buildAgentEnv(process.env, browserEnv(session));
      for (const key of ["AGENT_BROWSER_STREAM_PORT", "AGENT_BROWSER_CDP", "AGENT_BROWSER_AUTO_CONNECT", "AGENT_BROWSER_PROVIDER", "AGENT_BROWSER_NAMESPACE"]) delete env[key];
      const proc = Bun.spawn(["agent-browser", "--session", session, ...args], {
        cwd: home, env, stdout: "pipe", stderr: "pipe",
      });
      const abort = () => proc.kill();
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 120_000);
      if (signal?.aborted) abort();
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (code !== 0 || signal?.aborted) throw new Error(signal?.aborted ? "Browser command cancelled" : (stderr || stdout || "Browser command failed").slice(0, 2000));
        return stdout.slice(0, 32_000);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
    connect: (port) => new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=15`),
  };
}

function browserEnv(session: string): Record<string, string> {
  return { AGENT_BROWSER_SESSION: session, AGENT_BROWSER_STREAM_QUALITY: "60", AGENT_BROWSER_STREAM_MAX_WIDTH: "1280", AGENT_BROWSER_STREAM_MAX_HEIGHT: "800", AGENT_BROWSER_MAX_OUTPUT: "32000", AGENT_BROWSER_IDLE_TIMEOUT_MS: "0" };
}

interface Entry {
  status: BrowserStatus;
  session: string;
  ready: boolean;
  socket?: WebSocket;
  frame?: BrowserFrame;
  viewedAt: number;
  busy: number;
  touchedAt: number;
}

/** Processes and frames belong to a run, never to a viewer. Frames stay in memory only. */
export class BrowserManager {
  private readonly entries = new Map<string, Entry>();
  private readonly owned = new Set<string>();
  private readonly file: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly closing = new Map<string, Promise<void>>();
  constructor(private readonly stateDir: string, private readonly driver: BrowserDriver, private readonly now = Date.now) {
    this.file = join(stateDir, "browser-sessions.json");
    this.timer = setInterval(() => void this.sweep(), 1000);
    this.timer.unref();
  }

  async recover() {
    try {
      const names: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(names)) for (const name of names) if (typeof name === "string" && SESSION_RE.test(name)) this.owned.add(name);
    } catch {}
    for (const session of [...this.owned]) await this.closeOwned(session);
  }

  private persist() {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.owned]), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  private closeOwned(session: string): Promise<void> {
    const previous = this.closing.get(session);
    if (previous) return previous;
    const close = (async () => {
      try {
        await this.driver.run(session, ["close"]);
        this.owned.delete(session);
        this.persist();
      } catch { log.warn({ session }, "browser cleanup will retry"); }
      finally { this.closing.delete(session); }
    })();
    this.closing.set(session, close);
    return close;
  }

  bind(conversationId: string, runId: () => string | null): BrowserBinding {
    return new BrowserBinding(this, conversationId, runId);
  }

  create(conversationId: string, runId: string | null): Entry {
    const session = `sushii-${randomUUID()}`;
    const entry: Entry = { session, ready: false, status: { id: session, conversationId, runId, state: "starting", action: "Opening browser" }, viewedAt: 0, busy: 0, touchedAt: this.now() };
    this.owned.add(session);
    this.persist(); // Record ownership before the daemon starts, including failures and crashes.
    this.entries.set(session, entry);
    return entry;
  }

  async prepare(entry: Entry, signal?: AbortSignal) {
    if (entry.ready) return;
    await this.driver.run(entry.session, ["open", "about:blank"], signal);
    await this.driver.run(entry.session, ["set", "viewport", "1280", "800"], signal);
    entry.ready = true;
    entry.status.state = "active";
  }

  async execute(entry: Entry, args: string[], signal?: AbortSignal) {
    entry.busy++;
    entry.touchedAt = this.now();
    entry.status.action = LABELS[args[0]!] ?? "Using browser";
    try {
      await this.prepare(entry, signal);
      return await this.driver.run(entry.session, args, signal);
    } finally { entry.busy--; entry.touchedAt = this.now(); }
  }

  async finish(entry: Entry) {
    if (entry.status.state === "ended") return;
    entry.status = { ...entry.status, state: "ended", action: "Finished", endedAt: this.now() };
    entry.socket?.close();
    entry.socket = undefined;
    await this.closeOwned(entry.session);
  }

  async read(conversationId: string, frames: boolean): Promise<BrowserReadResult> {
    const matching = [...this.entries.values()].filter((e) => e.status.conversationId === conversationId).reverse();
    const entry = matching.find((e) => e.status.state !== "ended") ?? matching[0];
    if (!entry) return { status: null };
    if (frames && entry.status.state !== "ended" && entry.ready) {
      entry.viewedAt = this.now();
      if (!entry.socket) await this.stream(entry);
      if (entry.socket?.readyState === WebSocket.OPEN && entry.frame) entry.socket.send(JSON.stringify({ type: "ack", seq: entry.frame.seq }));
    }
    return { status: { ...entry.status }, ...(frames && entry.frame ? { frame: entry.frame } : {}) };
  }

  private connecting = new Set<string>();
  private async stream(entry: Entry) {
    if (this.connecting.has(entry.session)) return;
    this.connecting.add(entry.session);
    try {
      const raw = JSON.parse(await this.driver.run(entry.session, ["stream", "status", "--json"]));
      const port = raw.data?.port ?? raw.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || entry.status.state === "ended") return;
      const socket = this.driver.connect(port);
      entry.socket = socket;
      socket.onmessage = (event) => {
        if (entry.socket !== socket || typeof event.data !== "string" || event.data.length > 600_000) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "url" && typeof msg.url === "string" && msg.url.length <= 4096) entry.status.url = msg.url;
          if (msg.type === "tabs" && Array.isArray(msg.tabs)) {
            const url = msg.tabs.find((t: { active?: boolean }) => t.active)?.url;
            if (typeof url === "string" && url.length <= 4096) entry.status.url = url;
          }
          if (msg.type === "command" && typeof msg.action === "string") entry.status.action = LABELS[msg.action] ?? "Using browser";
          if (msg.type === "frame") {
            const frame = browserFrame.safeParse({ seq: msg.seq, data: msg.data, width: msg.metadata?.deviceWidth, height: msg.metadata?.deviceHeight, capturedAt: msg.metadata?.timestamp });
            if (frame.success) { entry.frame = frame.data; entry.status.state = "active"; }
            else socket.close();
          }
        } catch { socket.close(); }
      };
      socket.onclose = socket.onerror = () => { if (entry.socket === socket) entry.socket = undefined; };
    } catch { /* A daemon starting or restarting is retried on the next read. */ }
    finally { this.connecting.delete(entry.session); }
  }

  private async sweep() {
    for (const [conversation, entry] of this.entries) {
      if (entry.socket && this.now() - entry.viewedAt > 2000) { entry.socket.close(); entry.socket = undefined; }
      // Runs can wait indefinitely on an owner approval. Only abandoned bindings expire.
      if (!entry.busy && entry.status.state !== "ended" && this.now() - entry.touchedAt > 30 * 60_000) await this.finish(entry);
      if (entry.status.endedAt && this.now() - entry.status.endedAt > 60_000) this.entries.delete(conversation);
    }
    const active = new Set([...this.entries.values()].filter((e) => e.status.state !== "ended").map((e) => e.session));
    for (const session of this.owned) if (!active.has(session)) await this.closeOwned(session);
  }

  handlers(principalId: string) {
    return { [BROWSER_READ]: async (p: unknown) => {
      const q = browserReadParams.parse(p);
      if (q.principalId !== principalId) throw new Error("principal mismatch");
      return this.read(q.conversationId, q.frames);
    } };
  }

  async dispose() {
    clearInterval(this.timer);
    await Promise.all([...this.entries.values()].map((e) => this.finish(e)));
    for (const session of [...this.owned]) await this.closeOwned(session);
  }
}

export class BrowserBinding {
  private entry?: Entry;
  private closing: Promise<void> = Promise.resolve();
  constructor(private readonly manager: BrowserManager, private readonly conversationId: string, private readonly runId: () => string | null) {}
  async begin() {
    await this.closing;
    if (!this.entry || this.entry.status.state === "ended") this.entry = this.manager.create(this.conversationId, this.runId());
    return this.entry;
  }
  touch() { if (this.entry) this.entry.touchedAt = Date.now(); }
  finish() {
    const entry = this.entry;
    if (entry) this.closing = this.closing.then(() => this.manager.finish(entry));
    return this.closing;
  }
  wrapBash(tool: ToolDefinition): ToolDefinition {
    const execute = tool.execute.bind(tool);
    return { ...tool, execute: async (id, params, signal, onUpdate, ctx) => {
      const command = (params as { command?: string }).command ?? "";
      if (!/\bagent-browser\b/.test(command) || /\bagent-browser\s+(skills|--help|--version)\b/.test(command)) return execute(id, params, signal, onUpdate, ctx);
      // The managed env is provided at spawn time; never borrow a user's attached browser.
      if (/--(?:session|cdp|auto-connect|namespace|provider|all)\b|AGENT_BROWSER_(?:SESSION|CDP|NAMESPACE|PROVIDER)\s*=|\bconnect\s+/.test(command)) throw new Error("Use the browser tool or the provided AGENT_BROWSER_SESSION; separate browser sessions are not managed or previewed.");
      const entry = await this.begin();
      entry.busy++;
      entry.status.action = "Using browser";
      try {
        await this.manager.prepare(entry, signal);
        const result = await execute(id, params, signal, onUpdate, ctx);
        if (/\bagent-browser\s+close\b/.test(command)) await this.finish();
        return result;
      }
      finally { entry.busy--; entry.touchedAt = Date.now(); }
    } } as ToolDefinition;
  }
  env(): Record<string, string> { return this.entry ? browserEnv(this.entry.session) : {}; }
  tool(): ToolDefinition {
    return {
      name: "browser", label: "Browser",
      description: "Use the local Chromium browser with a live preview for the owner. Pass agent-browser command arguments as an array, e.g. ['open','https://example.com'], ['snapshot','-i'], ['click','@e3']. The workspace owns the session and closes it when the run settles. Do not override the session, connect another browser, or launch a daemon. API web research uses web_search/fetch_url_content instead.",
      promptSnippet: "browser: managed agent-browser commands with live preview and automatic cleanup; prefer this over Bash for browser actions",
      parameters: Type.Object({ args: Type.Array(Type.String({ maxLength: 16000 }), { minItems: 1, maxItems: 32 }) }) as ToolDefinition["parameters"],
      execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
        const { args } = params as { args: string[] };
        if (!Array.isArray(args) || !ACTIONS.has(args[0]!) || args.some((a) => /^--(?:session|namespace|cdp|auto-connect|provider|all|config|executable-path)(?:=|$)/.test(a))) throw new Error("Use a browser action in the managed local session.");
        const entry = await this.begin();
        const text = await this.manager.execute(entry, args, signal);
        if (args[0] === "close") await this.finish();
        return { content: [{ type: "text", text }], details: {} };
      },
    } as ToolDefinition;
  }
}
