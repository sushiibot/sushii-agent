import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, ExtensionAPI, PromptOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import { applySchema } from "../db/index.ts";
import { WorkspaceLinkStore } from "../db/workspaceLink.ts";
import { ORCH_CLOSE, RPC_METHODS, type ChatMessageParams } from "../orchestration/contracts.ts";
import { OrchestrationClient } from "../orchestration/transport/client.ts";
import { OrchestrationServer, type WorkspaceHandler } from "../orchestration/transport/server.ts";
import { DmConductorSession } from "../surfaces/discord/dmConductor.ts";
import { WorkspaceLink, type WorkspaceRpc } from "../orchestration/workspace/link.ts";
import type { Timers } from "../orchestration/workspace/progress.ts";
import { SurfaceRegistry } from "../orchestration/workspace/surface.ts";
import { handleOwnerDm, type DmCursor, type OwnerDmDeps, type OwnerDmMessage } from "../surfaces/discord/ownerDm.ts";
import { handleWorkspaceAskButton, handleWorkspaceStopButton, type WorkspaceButtonInteraction } from "../surfaces/discord/workspaceButtons.ts";
import { ACCENT, DiscordOwnerDmSurface, DiscordWorkspaceAdapter, OFFLINE_NOTICE, WS_STOP_PREFIX } from "../surfaces/discord/workspaceAdapter.ts";
import { PersonalSession, type ChatSession, type ChatSessionFactory } from "./personalSession.ts";
import { readWorkspaceState } from "./state.ts";
import { commandHandlers } from "./commands.ts";
import { ModelChoice } from "./modelChoice.ts";
import { ToolStubs } from "./toolStubs.ts";
import { AuthLogin, type LoginFn } from "./authLogin.ts";
import { BackendSelector } from "./chatgptFallback.ts";
import type { ToolEntry, ToolHosts } from "../core/contracts.ts";
import { WorkspaceTools, type AuditLog, type ToolCallAudit, type WorkspaceToolsOptions } from "../orchestration/workspace/tools.ts";
import { MainTurnTracker } from "./subagents/turnTracker.ts";
import { Scheduler } from "./scheduler.ts";
import { wireProactiveJobs } from "./proactive.ts";
import { RunLog } from "./runLog.ts";
import type { WorkspaceConfig } from "./config.ts";

// One process: real OrchestrationServer + WorkspaceLink + owner-DM router on the bot side, real
// OrchestrationClient + PersonalSession on the workspace side. Only Pi and Discord are faked.

const P = "drk";
const OWNER = "owner-1";
const SECRET = "e2e-workspace-secret";
const MODEL = "test/model";

// ── Fake Pi chat session ──────────────────────────────────────────────────────
// Idle prompt(): preflight, agent_start, user message, resolves at settle. Streaming prompt(): queues a steer.
// The test drives the run with tool() and reply(); abort() ends it as aborted.
class FakePi {
  isStreaming = false;
  isCompacting = false;
  prompts: string[] = [];
  steers: string[] = [];
  queue: string[] = [];
  customs: Array<{ content: unknown; options: unknown }> = [];
  messages: Array<{ role: string }> = [];
  aborts = 0;
  disposed = false;
  /** Tools registered through the session's extension API, as piChatSession's stub binding does. */
  readonly tools = new Map<string, ToolDefinition>();
  readonly extensionApi = { registerTool: (def: ToolDefinition) => void this.tools.set(def.name, def) } as unknown as ExtensionAPI;
  private listeners = new Set<(e: AgentSessionEvent) => void>();
  private runDone: (() => void) | null = null;
  private toolSeq = 0;

  constructor(readonly file: string) {}

  get pendingMessageCount(): number {
    return this.queue.length;
  }

  subscribe(listener: (e: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.prompts.push(text);
    if (this.isStreaming) {
      this.steers.push(text);
      this.queue.push(text);
      options?.preflightResult?.("queued");
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
    options?.preflightResult?.("started");
    this.isStreaming = true;
    const done = new Promise<void>((r) => (this.runDone = r));
    this.emit({ type: "agent_start" });
    this.emitUser(text);
    await done;
  }

  tool(name: string, args: Record<string, unknown>, ok = true): void {
    const toolCallId = `t${++this.toolSeq}`;
    this.emit({ type: "tool_execution_start", toolCallId, toolName: name, args });
    this.emit({ type: "tool_execution_end", toolCallId, toolName: name, result: "ok", isError: !ok });
  }

  /** Runs a real tool definition the way Pi would: start event, execute, end event, toolResult in the transcript. */
  async runTool(def: ToolDefinition, args: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const toolCallId = `t${++this.toolSeq}`;
    this.emit({ type: "tool_execution_start", toolCallId, toolName: def.name, args });
    let text: string;
    let isError = false;
    try {
      const r = await def.execute(toolCallId, args as never, signal, undefined, undefined as never);
      text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    } catch (err) {
      text = (err as Error).message;
      isError = true;
    }
    this.messages.push({ role: "toolResult", toolName: def.name, content: [{ type: "text", text }], isError } as { role: string });
    this.emit({ type: "tool_execution_end", toolCallId, toolName: def.name, result: text, isError });
  }

  toolStart(name: string, args: Record<string, unknown>): void {
    this.emit({ type: "tool_execution_start", toolCallId: `t${++this.toolSeq}`, toolName: name, args });
  }

  reply(text: string): void {
    for (const t of this.queue.splice(0)) this.emitUser(t);
    this.endMessage(text, "stop");
    this.settle();
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = this.queue;
    this.queue = [];
    return { steering, followUp: [] };
  }

  async abort(): Promise<void> {
    this.aborts++;
    if (!this.isStreaming) return;
    this.endMessage("", "aborted");
    this.settle();
  }

  async sendCustomMessage(message: { content: unknown }, options?: unknown): Promise<void> {
    this.customs.push({ content: message.content, options });
  }

  getContextUsage() {
    return { tokens: 1000, contextWindow: 10_000, percent: 10 };
  }

  dispose(): void {
    this.disposed = true;
  }

  private emit(e: unknown): void {
    for (const l of this.listeners) l(e as AgentSessionEvent);
  }

  private emitUser(text: string): void {
    this.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
  }

  private endMessage(text: string, stopReason: string): void {
    this.messages.push({ role: "assistant" });
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0 } },
      },
    });
  }

  private settle(): void {
    const done = this.runDone;
    this.runDone = null;
    this.isStreaming = false;
    this.emit({ type: "agent_settled" });
    done?.();
  }
}

// ── Fake Discord DM channel ───────────────────────────────────────────────────
interface Sent {
  id: string;
  options: MessageCreateOptions | string;
  edits: MessageEditOptions[];
}

function textOf(options: MessageCreateOptions | MessageEditOptions | string): string {
  if (typeof options === "string") return options;
  const components = (options.components ?? []).map((c) => ("toJSON" in c ? c.toJSON() : c));
  return `${options.content ?? ""}${JSON.stringify(components)}`;
}

class FakeDm {
  sent: Sent[] = [];
  reactions: Array<{ messageId: string; emoji: string }> = [];
  private seq = 0;

  async send(options: MessageCreateOptions | string) {
    const entry: Sent = { id: `bot-${++this.seq}`, options, edits: [] };
    this.sent.push(entry);
    return {
      id: entry.id,
      edit: async (o: MessageEditOptions) => {
        entry.edits.push(o);
      },
    };
  }

  /** Current rendered text of a message: its last edit, else what was sent. */
  current(s: Sent): string {
    return textOf(s.edits.at(-1) ?? s.options);
  }

  progress(): Sent[] {
    return this.sent.filter((s) => textOf(s.options).includes(WS_STOP_PREFIX));
  }

  /** Messages that aren't progress views. */
  replies(): Sent[] {
    return this.sent.filter((s) => !textOf(s.options).includes(WS_STOP_PREFIX));
  }

  reactionsOn(messageId: string): string[] {
    return this.reactions.filter((r) => r.messageId === messageId).map((r) => r.emoji);
  }

  message(id: string, content: string): OwnerDmMessage {
    return {
      id,
      channelId: "dm",
      content,
      author: { id: OWNER, name: "drk" },
      isVoice: false,
      attachments: [],
      react: async (emoji) => void this.reactions.push({ messageId: id, emoji }),
      send: (options) => this.send(options),
    };
  }
}

function turnIdOf(progress: Sent): string {
  const m = textOf(progress.options).match(/wsstop:([A-Za-z0-9]+)/);
  if (!m) throw new Error("progress message has no Stop button");
  return m[1]!;
}

// ── Harness ───────────────────────────────────────────────────────────────────
const immediateTimers: Timers = {
  set: (fn) => setTimeout(fn, 0),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

async function waitFor(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-e2e-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

type Kill = "none" | "on-deliver" | "on-ack";

interface Bot {
  server: OrchestrationServer;
  link: WorkspaceLink;
  port: number;
  deliverRequests: number;
  kill: Kill;
  /** Every chat/message the bot sent the workspace. */
  messages: ChatMessageParams[];
  /** Inputs the bot's fake web_search ran with, and the tool/call audit lines. */
  searches: Array<Record<string, unknown>>;
  audits: ToolCallAudit[];
  tools: WorkspaceTools;
  /** Titles the bot's fake file_linear_issue (an approval-gated tool) filed. */
  filed: string[];
}

function fakeWebSearch(searches: Array<Record<string, unknown>>): ToolEntry<keyof ToolHosts> {
  return {
    name: "web_search",
    definition: { name: "web_search", description: "Search the web (fake).", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    requiresHosts: [],
    async execute(input) {
      searches.push(input);
      return { content: `3 results for ${String(input.query)}` };
    },
  };
}

function fakeLinear(filed: string[]): ToolEntry<keyof ToolHosts> {
  const str = { type: "string" };
  return {
    name: "file_linear_issue",
    definition: {
      name: "file_linear_issue",
      description: "File a Linear issue (fake).",
      parameters: { type: "object", properties: { title: str, description: str, repo_label: str }, required: ["title", "description", "repo_label"] },
    },
    requiresHosts: [],
    async execute(input) {
      filed.push(String(input.title));
      return { content: "Filed ENG-1" };
    },
  };
}

function startServer(port: number): OrchestrationServer {
  const server = new OrchestrationServer({ port, secretGrants: { [SECRET]: { principalId: P } } });
  return server;
}

async function startBot(store: WorkspaceLinkStore, dm: FakeDm, port = 0, opts: { linear?: boolean } = {}): Promise<Bot> {
  const server = startServer(port);
  const surfaces = new SurfaceRegistry("discord").register(new DiscordWorkspaceAdapter({ ownerChannel: async () => dm }));
  const searches: Array<Record<string, unknown>> = [];
  const audits: ToolCallAudit[] = [];
  const audit: AuditLog = { info: (obj) => void audits.push(obj) };
  const filed: string[] = [];
  const tools = new WorkspaceTools({
    principalId: P,
    ownerUserId: () => OWNER,
    toolSpace: { surface: "discord", spaceId: "dm" },
    surfaces,
    store: {} as WorkspaceToolsOptions["store"],
    memory: { count: () => 0, getServerContext: () => null } as unknown as WorkspaceToolsOptions["memory"],
    registry: { resolve: () => [fakeWebSearch(searches), ...(opts.linear ? [fakeLinear(filed)] : [])] },
    log: audit,
  });
  const link = new WorkspaceLink({ principalId: P, store, surfaces, owner: () => ({ id: OWNER, name: "drk" }), timers: immediateTimers, tools });
  const bot: Bot = { server, link, port: 0, deliverRequests: 0, kill: "none", messages: [], searches, audits, tools, filed };
  const die = () => setTimeout(() => server.stop(), 0);
  // Wraps the real server only to observe traffic and to simulate the bot process dying at a chosen point.
  const rpc: WorkspaceRpc = {
    getWorkspaceConnection: (p) => server.getWorkspaceConnection(p),
    requestWorkspace: (p, method, params, timeoutMs) => {
      if (method === RPC_METHODS.chatMessage) bot.messages.push(params as ChatMessageParams);
      if (method === RPC_METHODS.chatAck && bot.kill === "on-ack") {
        die();
        return new Promise(() => {});
      }
      return server.requestWorkspace(p, method, params, timeoutMs);
    },
    setWorkspaceHandler: (handler: WorkspaceHandler | null) => {
      if (!handler) return server.setWorkspaceHandler(null);
      server.setWorkspaceHandler({
        ...handler,
        onRequest: (conn, method, params) => {
          if (method === RPC_METHODS.chatDeliver) {
            bot.deliverRequests++;
            if (bot.kill === "on-deliver") {
              die();
              return new Promise(() => {});
            }
          }
          return handler.onRequest!(conn, method, params);
        },
      });
    },
  };
  link.attach(rpc);
  for (let attempt = 0; ; attempt++) {
    try {
      bot.port = server.listen().port!;
      break;
    } catch (err) {
      if (attempt > 50) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  cleanups.push(() => server.stop());
  return bot;
}

interface Workspace {
  personal: PersonalSession;
  auth: AuthLogin;
  selector: BackendSelector;
  /** The Pi login the auth handlers run; tests replace it. */
  login: LoginFn;
  toolStubs: ToolStubs;
  /** Follows main's turns from its outgoing chat/events, as index.ts does for subagent progress. */
  turns: MainTurnTracker;
  sessions: FakePi[];
  stateDir: string;
  client: OrchestrationClient | null;
  /** The live fake Pi session. */
  pi(): FakePi;
  connect(url: string, secret?: string): OrchestrationClient;
  disconnect(): void;
  /** Outbox ids with no ack line. */
  unacked(): string[];
}

async function startWorkspace(): Promise<Workspace> {
  const stateDir = tempDir();
  const sessions: FakePi[] = [];
  const factory: ChatSessionFactory = async () => {
    const s = new FakePi(join(stateDir, `chat-${sessions.length + 1}.jsonl`));
    ws.toolStubs.binding().factory(s.extensionApi);
    sessions.push(s);
    return { session: s as unknown as ChatSession, sessionFile: s.file };
  };
  const ws: Workspace = {
    personal: null as unknown as PersonalSession,
    auth: null as unknown as AuthLogin,
    selector: new BackendSelector({ primaryEnabled: true }),
    login: async () => {
      throw new Error("no login configured");
    },
    toolStubs: new ToolStubs({
      principalId: P,
      request: (method, params, timeoutMs) => (ws.client ? ws.client.request(method, params, { timeoutMs }) : Promise.reject(new Error("not connected"))),
    }),
    turns: new MainTurnTracker(),
    sessions,
    stateDir,
    client: null,
    pi: () => sessions.at(-1)!,
    connect(url, secret = SECRET) {
      const client = new OrchestrationClient({
        url,
        runnerId: `workspace-${P}`,
        kind: "pi-workspace",
        secret,
        principalId: P,
        state: () => ws.personal.state,
        handlers: {
          ...ws.personal.handlers(),
          ...ws.auth.handlers(),
          ...commandHandlers({
            principalId: P,
            compact: async () => ({ error: "Nothing to compact (session too small)" }),
            choice: new ModelChoice({ provider: "chatgpt", chatgptModel: "gpt-6.1-sol", model: "openai/gpt-6-luna" } as WorkspaceConfig, stateDir),
            tasks: (arg) => (arg ? `project ${arg}: no open sub-tasks` : "**Quick**\n- Book dentist"),
          }),
        },
        onRegistered: (result) => {
          ws.toolStubs.update(result?.tools ?? []);
          ws.personal.onRegistered();
        },
        heartbeatMs: 0,
        backoffCapMs: 100,
      });
      ws.client = client;
      void client.run();
      cleanups.push(() => client.close());
      return client;
    },
    disconnect() {
      ws.client?.close();
      ws.client = null;
    },
    unacked() {
      const pending = new Set<string>();
      let raw = "";
      try {
        raw = readFileSync(join(stateDir, "outbox.jsonl"), "utf8");
      } catch {
        return [];
      }
      for (const line of raw.split("\n").filter(Boolean)) {
        const l = JSON.parse(line) as { type: string; entry?: { outboxId: string }; outboxId?: string };
        if (l.type === "entry") pending.add(l.entry!.outboxId);
        else pending.delete(l.outboxId!);
      }
      return [...pending];
    },
  };
  ws.personal = new PersonalSession({
    principalId: P,
    model: MODEL,
    stateDir,
    factory,
    textDeltaMs: null,
    transport: {
      request: (method, params) => (ws.client ? ws.client.request(method, params) : Promise.reject(new Error("not connected"))),
      notify: (method, params) => {
        ws.turns.observe(method, params);
        ws.client?.notify(method, params);
      },
      isConnected: () => ws.client?.connected ?? false,
    },
    resendIntervalMs: 200,
    now: () => NOW,
  });
  ws.auth = new AuthLogin({
    principalId: P,
    login: (interaction) => ws.login(interaction),
    deliver: (d) => ws.personal.deliverOutOfBand(d),
    model: "gpt-6.1-sol",
    onLoggedIn: () => ws.selector.reset(),
  });
  await ws.personal.start();
  cleanups.push(() => ws.personal.dispose());
  cleanups.push(() => ws.auth.cancel());
  return ws;
}

interface Router {
  deps: OwnerDmDeps;
  inProcess: Array<{ text: string; notice?: string }>;
  dm(id: string, content: string): Promise<void>;
}

function router(link: () => WorkspaceLink, dm: FakeDm): Router {
  let cursor: string | null = null;
  const memCursor: DmCursor = { get: () => cursor, set: (id) => void (cursor = id) };
  const inProcess: Router["inProcess"] = [];
  const deps: OwnerDmDeps = {
    workspaceEnabled: true,
    transcriptionEnabled: false,
    get link() {
      return link();
    },
    surface: new DiscordOwnerDmSurface({
      transcribe: async () => null,
      // The real fallback delivery path; only the in-process agent loop is skipped.
      runInProcess: async (_m, text, { notice }) => {
        inProcess.push({ text, ...(notice ? { notice } : {}) });
        const session = new DmConductorSession(dm, { id: "bot", username: "sushii" }, notice ? { notice, accentColor: ACCENT.warning } : {});
        await session.deliver({
          segments: [{ kind: "text", text: `fallback answer to: ${text}` }],
          usage: { model: "fallback/model", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 1, contextLimit: 100 },
          toolTrace: [],
          cancelled: false,
        });
        return session.deliveredText;
      },
      resetInProcess: async () => {},
    }),
    cursor: memCursor,
  };
  return { deps, inProcess, dm: (id, content) => handleOwnerDm(dm.message(id, content), deps) };
}

async function linked(opts: { linear?: boolean } = {}) {
  const dm = new FakeDm();
  const db = new Database(":memory:");
  applySchema(db);
  const store = new WorkspaceLinkStore(db);
  const bot = await startBot(store, dm, 0, opts);
  const ws = await startWorkspace();
  const r = { bot };
  const route = router(() => r.bot.link, dm);
  return { dm, store, r, ws, route, url: () => `ws://localhost:${r.bot.port}` };
}

async function connected(h: Awaited<ReturnType<typeof linked>>): Promise<void> {
  h.ws.connect(h.url());
  await waitFor(() => h.r.bot.link.isConnected() && h.ws.client!.connected, "workspace registered");
}

function stopInteraction(turnId: string) {
  const editReplies: unknown[] = [];
  const interaction = {
    customId: `${WS_STOP_PREFIX}${turnId}`,
    id: `int-${turnId}`,
    channelId: "dm",
    user: { id: OWNER, username: "drk", globalName: "drk" },
    component: { label: "Stop" },
    message: { components: [], edit: async () => {} },
    reply: async () => {},
    deferReply: async () => {},
    editReply: async (o: unknown) => void editReplies.push(o),
  } as unknown as WorkspaceButtonInteraction;
  return { interaction, editReplies };
}

const NOW = new Date("2026-09-29T12:00:00Z");
/** The prompt text for a message whose (test) id isn't a snowflake, so it carries the receipt time. */
const stamped = (messageId: string, text: string) => `[discord:${messageId} 2026-09-29 12:00 UTC]\n${text}`;

// ── Scenarios ─────────────────────────────────────────────────────────────────
describe("workspace e2e (bot ↔ transport ↔ workspace)", () => {
  test("1. a DM gets 👀, a live progress view, then the reply with footer and tool count; the outbox is acked", async () => {
    const h = await linked();
    await connected(h);

    await h.route.dm("100", "what's in my home dir?");
    expect(h.dm.reactionsOn("100")).toEqual(["👀"]);
    expect(h.ws.pi().prompts).toEqual([stamped("100", "what's in my home dir?")]);

    h.ws.pi().tool("bash", { command: "ls -la ~" });
    await waitFor(() => h.dm.progress().length === 1, "progress message");
    const progress = h.dm.progress()[0]!;
    expect(textOf(progress.options)).toContain("`bash` ls -la ~");
    expect(textOf(progress.options)).toContain("started <t:");

    h.ws.pi().tool("read", { path: "notes.md" });
    await waitFor(() => h.dm.current(progress).includes("`read`"), "progress edit with the second tool");
    expect(h.dm.current(progress)).toContain("✓ `bash`");

    h.ws.pi().reply("You have notes.md and a repos/ dir.");
    await waitFor(() => h.dm.replies().length === 1, "reply");
    const reply = textOf(h.dm.replies()[0]!.options);
    expect(reply).toContain("You have notes.md and a repos/ dir.");
    expect(reply).toContain(`-# ${MODEL} · ctx 10% · 20 out · cache 50r 0w · 2 tools`);

    await waitFor(() => h.dm.current(progress).includes("✓ done"), "progress finalized");
    expect(h.dm.current(progress)).toContain("2 tools");
    expect(h.dm.current(progress)).not.toContain(WS_STOP_PREFIX);
    await waitFor(() => h.ws.unacked().length === 0, "outbox acked");
    expect(readFileSync(join(h.ws.stateDir, "outbox.jsonl"), "utf8")).toContain('"type":"ack"');
  });

  test("2. a second DM mid-turn steers (↪️) and the single reply answers it", async () => {
    const h = await linked();
    await connected(h);

    await h.route.dm("200", "summarize the repo");
    h.ws.pi().tool("bash", { command: "git log -5" });
    await h.route.dm("201", "also list open PRs");
    expect(h.dm.reactionsOn("201")).toEqual(["↪️"]);
    expect(h.ws.pi().steers).toEqual([stamped("201", "also list open PRs")]);
    expect(h.ws.pi().prompts).toHaveLength(2);

    h.ws.pi().reply("Summary + PRs.");
    await waitFor(() => h.dm.replies().length === 1, "reply");
    await waitFor(() => h.ws.unacked().length === 0, "outbox acked");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.dm.replies()).toHaveLength(1);
    expect(h.r.bot.deliverRequests).toBe(1);
  });

  test("3. Stop with the current turnId aborts; a stale turnId (live next turn) does not", async () => {
    const h = await linked();
    await connected(h);

    await h.route.dm("300", "first");
    h.ws.pi().tool("bash", { command: "echo 1" });
    await waitFor(() => h.dm.progress().length === 1, "turn 1 progress");
    const stale = turnIdOf(h.dm.progress()[0]!);
    h.ws.pi().reply("one");
    await waitFor(() => h.dm.replies().length === 1, "turn 1 reply");

    await h.route.dm("301", "second, long running");
    h.ws.pi().toolStart("bash", { command: "sleep 600" });
    await waitFor(() => h.dm.progress().length === 2, "turn 2 progress");
    const current = turnIdOf(h.dm.progress()[1]!);
    expect(current).not.toBe(stale);

    const staleClick = stopInteraction(stale);
    await handleWorkspaceStopButton(staleClick.interaction, { link: h.r.bot.link });
    expect(staleClick.editReplies).toEqual(["That turn already finished."]);
    expect(h.ws.pi().aborts).toBe(0);
    expect(h.ws.pi().isStreaming).toBe(true);

    const click = stopInteraction(current);
    await handleWorkspaceStopButton(click.interaction, { link: h.r.bot.link });
    expect(click.editReplies).toEqual(["Stopping…"]);
    expect(h.ws.pi().aborts).toBe(1);
    const progress2 = h.dm.progress()[1]!;
    await waitFor(() => h.dm.current(progress2).includes("⏹ stopped"), "turn 2 progress shows stopped");

    await new Promise((r) => setTimeout(r, 50));
    expect(h.dm.replies()).toHaveLength(1);
    expect(h.ws.unacked()).toEqual([]);
  });

  test("4. !new swaps the Pi session, records it in state.json, and later DMs prompt the new session", async () => {
    const h = await linked();
    await connected(h);
    await h.route.dm("400", "hello");
    h.ws.pi().reply("hi");
    await waitFor(() => h.dm.replies().length === 1, "first reply");
    const first = h.ws.pi();

    await h.route.dm("401", "!new");
    expect(h.dm.reactionsOn("401")).toEqual(["🧠"]);
    expect(textOf(h.dm.replies().at(-1)!.options)).toContain("✅ New session.");
    expect(h.ws.sessions).toHaveLength(2);
    expect(first.disposed).toBe(true);
    expect(readWorkspaceState(h.ws.stateDir)?.chatSessionFile).toBe(h.ws.pi().file);
    expect(h.r.bot.messages.map((m) => m.messageId)).not.toContain("401");

    await h.route.dm("402", "fresh start");
    expect(h.ws.pi().prompts).toEqual([stamped("402", "fresh start")]);
    expect(first.prompts).toEqual([stamped("400", "hello")]);
  });

  test("5a. bot dies after sending the reply but before chat/ack: the restarted bot acks without resending", async () => {
    const h = await linked();
    await connected(h);
    await h.route.dm("500", "do a thing");
    h.ws.pi().tool("bash", { command: "make" });
    await waitFor(() => h.dm.progress().length === 1, "progress");

    h.r.bot.kill = "on-ack";
    h.ws.pi().reply("done the thing");
    await waitFor(() => h.dm.replies().length === 1, "reply sent to Discord");
    await waitFor(() => !h.ws.client!.connected, "bot gone");
    expect(h.ws.unacked()).toHaveLength(1);

    h.r.bot = await startBot(h.store, h.dm, h.r.bot.port);
    await waitFor(() => h.r.bot.deliverRequests >= 1, "workspace resent the delivery", 5000);
    await waitFor(() => h.ws.unacked().length === 0, "outbox acked by the new bot");
    expect(h.dm.replies()).toHaveLength(1);
  });

  test("5b. bot dies on receiving chat/deliver: the restarted bot delivers it exactly once", async () => {
    const h = await linked();
    await connected(h);
    await h.route.dm("510", "do a thing");
    h.ws.pi().tool("bash", { command: "make" });
    await waitFor(() => h.dm.progress().length === 1, "progress");

    h.r.bot.kill = "on-deliver";
    h.ws.pi().reply("done the thing");
    await waitFor(() => !h.ws.client!.connected, "bot gone");
    expect(h.dm.replies()).toHaveLength(0);
    expect(h.ws.unacked()).toHaveLength(1);

    h.r.bot = await startBot(h.store, h.dm, h.r.bot.port);
    await waitFor(() => h.ws.unacked().length === 0, "outbox acked by the new bot", 5000);
    // Let the periodic resend run at least once more: it must not produce a second message.
    await new Promise((r) => setTimeout(r, 400));
    expect(h.dm.replies()).toHaveLength(1);
    expect(textOf(h.dm.replies()[0]!.options)).toContain("done the thing");
  });

  test("5c. bot dies mid-turn, the reply lands while it is down, and the restarted bot delivers it once", async () => {
    const h = await linked();
    await connected(h);
    await h.route.dm("520", "long job");
    h.ws.pi().toolStart("bash", { command: "sleep 30" });
    await waitFor(() => h.dm.progress().length === 1, "progress");

    h.r.bot.server.stop();
    await waitFor(() => !h.ws.client!.connected, "bot gone");
    h.ws.pi().reply("job finished");
    expect(h.ws.unacked()).toHaveLength(1);

    h.r.bot = await startBot(h.store, h.dm, h.r.bot.port);
    await waitFor(() => h.ws.unacked().length === 0, "outbox acked by the new bot", 5000);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.dm.replies()).toHaveLength(1);
    expect(textOf(h.dm.replies()[0]!.options)).toContain("job finished");
  });

  test("6. workspace offline: fallback note + inbox row; replayed as context on reconnect without a reply", async () => {
    const h = await linked();
    await connected(h);
    h.ws.disconnect();
    await waitFor(() => !h.r.bot.link.isConnected(), "workspace disconnected");

    await h.route.dm("600", "are you there?");
    expect(h.dm.reactionsOn("600")).toEqual(["👀"]);
    expect(h.route.inProcess).toEqual([{ text: "are you there?", notice: OFFLINE_NOTICE }]);
    expect(h.dm.replies()).toHaveLength(1);
    expect(textOf(h.dm.replies()[0]!.options)).toContain("workspace offline");
    const rows = h.store.listInbox(P);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userText).toBe("are you there?");

    await connected(h);
    await waitFor(() => h.store.listInbox(P).length === 0, "inbox drained");
    const replayed = h.r.bot.messages.filter((m) => m.kind === "context");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.messageId).toBe(`inbox:${rows[0]!.id}`);
    const pi = h.ws.pi();
    expect(pi.customs).toHaveLength(1);
    expect(String(pi.customs[0]!.content)).toContain("User: are you there?");
    expect(pi.customs[0]!.options).toEqual({ triggerTurn: false });
    expect(pi.prompts).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.r.bot.deliverRequests).toBe(0);
    expect(h.dm.replies()).toHaveLength(1);
  });

  test("7. a wrong secret is rejected with 4401, and the DM falls back", async () => {
    const h = await linked();
    const bad = new OrchestrationClient({ url: h.url(), runnerId: `workspace-${P}`, kind: "pi-workspace", secret: "wrong", principalId: P, heartbeatMs: 0 });
    cleanups.push(() => bad.close());
    const closed = new Promise<number>((resolve) => {
      const probe = new WebSocket(h.url());
      probe.addEventListener("open", () =>
        probe.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: RPC_METHODS.register, params: { runnerId: "probe", kind: "pi-workspace", role: "workspace", secret: "wrong" } })),
      );
      probe.addEventListener("close", (e) => resolve(e.code));
    });
    await expect(bad.connect()).rejects.toThrow("unauthorized");
    expect(await closed).toBe(ORCH_CLOSE.unauthorized);
    expect(h.r.bot.link.isConnected()).toBe(false);

    await h.route.dm("700", "hello?");
    expect(h.route.inProcess).toEqual([{ text: "hello?", notice: OFFLINE_NOTICE }]);
    expect(h.store.listInbox(P)).toHaveLength(1);
  });

  test("7b. a wrong-secret register does not evict the live workspace", async () => {
    const h = await linked();
    await connected(h);
    const bad = new OrchestrationClient({ url: h.url(), runnerId: `workspace-${P}`, kind: "pi-workspace", secret: "wrong", principalId: P, heartbeatMs: 0 });
    cleanups.push(() => bad.close());
    await expect(bad.connect()).rejects.toThrow("unauthorized");
    expect(h.r.bot.link.isConnected()).toBe(true);
    await h.route.dm("710", "still there?");
    expect(h.dm.reactionsOn("710")).toEqual(["👀"]);
    expect(h.route.inProcess).toEqual([]);
  });

  test("8. a duplicate messageId, sequential or concurrent, never prompts twice", async () => {
    const h = await linked();
    await connected(h);

    await Promise.all([h.route.dm("800", "once please"), h.route.dm("800", "once please")]);
    expect(h.ws.pi().prompts).toEqual([stamped("800", "once please")]);
    expect(h.dm.reactionsOn("800")).toEqual(["👀"]);

    h.ws.pi().reply("once");
    await waitFor(() => h.dm.replies().length === 1, "reply");
    await h.route.dm("800", "once please");
    expect(h.ws.pi().prompts).toEqual([stamped("800", "once please")]);
    expect(h.dm.reactionsOn("800")).toEqual(["👀"]);
    const modes = h.r.bot.messages.filter((m) => m.messageId === "800");
    expect(modes).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.dm.replies()).toHaveLength(1);
  });

  test("9. a bot tool round-trip: the manifest arrives at register, the stub calls the bot, the result lands in the transcript", async () => {
    const h = await linked();
    await connected(h);
    await waitFor(() => h.ws.toolStubs.names().length > 0, "tool manifest");
    expect(h.ws.toolStubs.names()).toEqual(["web_search"]);
    await waitFor(() => h.ws.pi().tools.has("web_search"), "stub registered in the live session");
    const search = h.ws.pi().tools.get("web_search")!;
    expect(search.parameters).toMatchObject({ required: ["query"], additionalProperties: false });

    await h.route.dm("900", "search for bun releases");
    await h.ws.pi().runTool(search, { query: "bun releases" });
    expect(h.r.bot.searches).toEqual([{ query: "bun releases" }]);
    expect(h.r.bot.audits).toMatchObject([{ principalId: P, agentId: "main", agentName: "main", name: "web_search", ok: true, denied: false }]);
    expect(h.ws.pi().messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "web_search", isError: false, content: [{ type: "text", text: "3 results for bun releases" }] });

    await waitFor(() => h.dm.progress().length === 1, "progress");
    expect(textOf(h.dm.progress()[0]!.options)).toContain("`web_search`");
    h.ws.pi().reply("Bun 2.0 is out.");
    await waitFor(() => h.dm.replies().length === 1, "reply");
    expect(textOf(h.dm.replies()[0]!.options)).toContain("Bun 2.0 is out.");
  });

  test("10. stopping a turn mid-approval withdraws the call: the prompt shows Cancelled and a later Approve runs nothing", async () => {
    const h = await linked({ linear: true });
    await connected(h);
    await waitFor(() => h.ws.pi().tools.has("file_linear_issue"), "ask stub registered in the live session");

    await h.route.dm("1000", "file a bug about login");
    const ac = new AbortController();
    const run = h.ws.pi().runTool(h.ws.pi().tools.get("file_linear_issue")!, { title: "Login crash", description: "D", repo_label: "sushii-bot" }, ac.signal);
    const promptOf = () => h.dm.sent.find((s) => textOf(s.options).includes("wsap:"));
    await waitFor(() => promptOf() !== undefined, "approval prompt");
    const prompt = promptOf()!;
    const nonce = /wsap:([A-Za-z0-9_-]{16}):approve/.exec(textOf(prompt.options))![1]!;

    ac.abort();
    await run;
    expect(h.ws.pi().messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "file_linear_issue", isError: true });
    await waitFor(() => h.dm.current(prompt).includes("⏹ Cancelled"), "prompt shows Cancelled");
    expect(h.r.bot.tools.decide(nonce, "approve", { surface: "discord", userId: OWNER, name: "drk" })).toBe("expired");
    expect(h.r.bot.filed).toEqual([]);
    h.ws.pi().reply("Stopped.");
  });
});

describe("workspace e2e: delegate, scheduled jobs, auto-mode asks", () => {
  test("11. a subagent's tool calls nest under the turn that delegated, and count toward its tools", async () => {
    const h = await linked();
    await connected(h);

    await h.route.dm("1100", "research the outage");
    h.ws.pi().toolStart("delegate", { agent: "researcher", task: "find the outage cause" });
    await waitFor(() => h.dm.progress().length === 1, "progress message");
    const progress = h.dm.progress()[0]!;
    const turn = h.ws.turns.current();
    expect(turn?.turnId).toBe(turnIdOf(progress));

    // What SubagentHost.emit sends for the child's calls.
    const child = (ev: { type: "tool_start"; name: string; summary: string } | { type: "tool_end"; name: string; ok: boolean }) =>
      h.ws.client!.notify(RPC_METHODS.chatEvent, { principalId: P, turnId: turn!.turnId, agentId: "run-child-1", parentRunId: "run-main-1", ev });
    child({ type: "tool_start", name: "read", summary: "incident.md" });
    await waitFor(() => h.dm.current(progress).includes("↳"), "nested child line");
    child({ type: "tool_end", name: "read", ok: true });
    await waitFor(() => h.dm.current(progress).includes("↳ ✓ `read` incident.md"), "child line finished");

    h.ws.pi().reply("The cert expired.");
    await waitFor(() => h.dm.replies().length === 1, "reply");
    await waitFor(() => h.dm.current(progress).includes("✓ done"), "progress finalized");
    expect(h.dm.current(progress)).toContain("2 tools");
  });

  test("12. a scheduled job's reply reaches the DM as a proactive message and lands in the chat as context, with no turn", async () => {
    const h = await linked();
    await connected(h);
    const home = tempDir();
    const config = {
      principalId: P,
      home,
      stateDir: h.ws.stateDir,
      tz: "America/Los_Angeles",
      heartbeat: { when: { kind: "every", minutes: 120 } },
      proactiveDailyCap: 6,
    } as unknown as WorkspaceConfig;
    const scheduler = new Scheduler({ stateDir: h.ws.stateDir, at: "04:00", tz: config.tz });
    cleanups.push(() => scheduler.stop());
    const replies = ["Your passport renewal is due Friday.", "NO_REPLY"];
    // The deliver and note wiring is index.ts's; only the job's model run is faked.
    wireProactiveJobs(scheduler, {
      config,
      runs: new RunLog(h.ws.stateDir),
      selector: new BackendSelector({ primaryEnabled: false }),
      runner: async () => ({ text: replies.shift()! }) as Awaited<ReturnType<NonNullable<Parameters<typeof wireProactiveJobs>[1]["runner"]>>>,
      deliver: (text) => h.ws.personal.deliverOutOfBand({ kind: "proactive", text }),
      note: async (name, text) => {
        await h.ws.personal.handleMessage({
          origin: { surface: "workspace", conversationId: "schedule" },
          principalId: P,
          messageId: `job:${name}:1`,
          text,
          kind: "context",
          author: { id: "workspace", name: "scheduler" },
        });
      },
    });

    expect(await scheduler.runJob("heartbeat", { trigger: "manual", force: true })).toMatchObject({ status: "sent" });
    await waitFor(() => h.dm.replies().some((s) => textOf(s.options).includes("passport renewal")), "proactive DM");
    expect(h.ws.pi().prompts).toEqual([]);
    expect(JSON.stringify(h.ws.pi().customs)).toContain("You sent drk this proactive message: Your passport renewal is due Friday.");
    await waitFor(() => h.ws.unacked().length === 0, "proactive delivery acked");

    const before = h.dm.sent.length;
    expect(await scheduler.runJob("heartbeat", { trigger: "manual", force: true })).toMatchObject({ status: "no_reply" });
    expect(h.dm.sent).toHaveLength(before);
  });

  test("13. an auto-mode ask mid-turn becomes Yes/No buttons; the owner's click answers the dialog, not the agent", async () => {
    const h = await linked();
    await connected(h);

    await h.route.dm("1300", "clean the build dir");
    // What the auto-mode extension does on an "ask" verdict, through the session's bound UI context.
    const allowed = h.ws.personal.ui.confirm("Auto mode: allow this tool call?", "bash: rm -rf build\n\nWhy it's asking: recursive delete");
    const askOf = () => h.dm.sent.find((s) => textOf(s.options).includes("wsask:"));
    await waitFor(() => askOf() !== undefined, "ask prompt");
    const ask = askOf()!;
    expect(textOf(ask.options)).toContain("rm -rf build");
    const askId = /wsask:([A-Za-z0-9]+):0/.exec(textOf(ask.options))![1]!;

    const editReplies: unknown[] = [];
    const interaction = {
      customId: `wsask:${askId}:0`,
      id: "int-ask",
      channelId: "dm",
      user: { id: OWNER, username: "drk", globalName: "drk" },
      component: { label: "Yes" },
      message: { components: [], edit: async () => {} },
      reply: async () => {},
      deferReply: async () => {},
      editReply: async (o: unknown) => void editReplies.push(o),
    } as unknown as WorkspaceButtonInteraction;
    await handleWorkspaceAskButton(interaction, { link: h.r.bot.link });

    expect(await allowed).toBe(true);
    expect(editReplies).toEqual(["Answered: Yes"]);
    expect(h.ws.pi().prompts).toEqual([stamped("1300", "clean the build dir")]);
    h.ws.pi().reply("Cleaned.");
    await waitFor(() => h.dm.replies().some((s) => textOf(s.options).includes("Cleaned.")), "reply");
  });
});

describe("workspace commands and asks outside a turn", () => {
  test("14. !tasks, !model and !compact go over chat/command and answer in the DM without reaching the agent", async () => {
    const h = await linked();
    await connected(h);
    await h.route.dm("1400", "!tasks");
    await waitFor(() => h.dm.sent.some((s) => textOf(s.options).includes("Book dentist")), "tasks reply");
    await h.route.dm("1401", "!tasks osaka");
    await waitFor(() => h.dm.sent.some((s) => textOf(s.options).includes("project osaka")), "project reply");
    await h.route.dm("1402", "!model luna");
    await waitFor(() => h.dm.sent.some((s) => textOf(s.options).includes("Model set to **luna**")), "model reply");
    await h.route.dm("1403", "!compact");
    await waitFor(() => h.dm.sent.some((s) => textOf(s.options).includes("Didn't compact")), "compact reply");
    expect(h.ws.pi().prompts).toEqual([]);
  });

  test("15. a workspace ask with no turn (the task review) gets buttons on the preferred surface; a click answers it", async () => {
    const h = await linked();
    await connected(h);
    const answer = h.ws.personal.askOwner("Stale: 1. Dentist", ["Keep all", "Drop all"], (t) => (/^(keep|drop) all$/i.test(t) ? { value: t.toLowerCase() } : null));
    const askOf = () => h.dm.sent.find((s) => textOf(s.options).includes("Stale: 1. Dentist"));
    await waitFor(() => askOf() !== undefined, "review ask");
    const askId = /wsask:([A-Za-z0-9]+):1/.exec(textOf(askOf()!.options))![1]!;
    const interaction = {
      customId: `wsask:${askId}:1`,
      id: "int-review",
      channelId: "dm",
      user: { id: OWNER, username: "drk", globalName: "drk" },
      component: { label: "Drop all" },
      message: { components: [], edit: async () => {} },
      reply: async () => {},
      deferReply: async () => {},
      editReply: async () => {},
    } as unknown as WorkspaceButtonInteraction;
    await handleWorkspaceAskButton(interaction, { link: h.r.bot.link });
    expect(await answer).toBe("drop all");
    expect(h.ws.pi().prompts).toEqual([]);
  });
});

describe("ChatGPT login from the owner's DM", () => {
  test("!login chatgpt → sign-in link → pasted callback → connected; the paste never reaches the agent", async () => {
    const h = await linked();
    await connected(h);
    // A dead refresh token already sent the workspace onto OpenRouter.
    h.ws.selector.onChatGptFailure("OAuth refresh failed: invalid_grant");
    expect(h.ws.selector.select(true)).toBe("openrouter");
    const stored: string[] = [];
    h.ws.login = async (interaction) => {
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/api/accounts/authorize?state=st4te" });
      const input = await interaction.prompt({ type: "manual_code", message: "paste", signal: interaction.signal });
      const url = new URL(input);
      if (url.origin !== "http://127.0.0.1:1455" || url.searchParams.get("state") !== "st4te") throw new Error("OAuth state mismatch");
      stored.push(url.searchParams.get("code")!);
    };

    await h.route.dm("100", "!login chatgpt");
    await waitFor(() => h.dm.sent.some((s) => textOf(s.options).includes("Sign in with ChatGPT")), "the sign-in prompt");
    const prompt = h.dm.sent.find((s) => textOf(s.options).includes("Sign in with ChatGPT"))!;
    expect(textOf(prompt.options)).toContain("https://auth.openai.com/api/accounts/authorize?state=st4te");
    expect(textOf(prompt.options)).toContain("`!login cancel` to abort");
    expect(h.r.bot.link.isLoginPending()).toBe(true);

    await h.route.dm("101", "http://localhost:1455/auth/callback?code=SECRET-CODE&state=st4te&client_id=c");
    await waitFor(() => h.dm.sent.some((s) => textOf(s.options).includes("ChatGPT connected")), "the result reply");
    expect(textOf(h.dm.sent.at(-1)!.options)).toContain("✅ ChatGPT connected · gpt-6.1-sol");
    expect(stored).toEqual(["SECRET-CODE"]);

    expect(h.r.bot.messages).toEqual([]);
    expect(h.ws.pi().prompts.join("\n")).not.toContain("SECRET-CODE");
    expect(h.store.listInbox(P)).toEqual([]);
    expect(h.r.bot.link.isLoginPending()).toBe(false);
    expect(h.dm.reactionsOn("101")).toEqual(["👀"]);
    expect(h.ws.selector.select(true)).toBe("chatgpt");
    await waitFor(() => h.ws.unacked().length === 0, "auth deliveries acked");

    // Afterwards an ordinary message goes to the agent again.
    await h.route.dm("102", "hi");
    await waitFor(() => h.r.bot.messages.length === 1, "chat/message");
  });
});
