import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import { applySchema } from "../db/index.ts";
import { WorkspaceLinkStore } from "../db/workspaceLink.ts";
import { ORCH_CLOSE, RPC_METHODS, type ChatMessageParams } from "../orchestration/contracts.ts";
import { OrchestrationClient } from "../orchestration/transport/client.ts";
import { OrchestrationServer, type WorkspaceHandler } from "../orchestration/transport/server.ts";
import { DmConductorSession } from "../surfaces/discord/dmConductor.ts";
import { handleOwnerDm, type DmCursor, type OwnerDmDeps, type OwnerDmMessage } from "../surfaces/discord/ownerDm.ts";
import { handleWorkspaceStopButton, type WorkspaceButtonInteraction } from "../surfaces/discord/workspaceButtons.ts";
import { ACCENT, OFFLINE_NOTICE, WS_STOP_PREFIX, WorkspaceLink, type Timers, type WorkspaceRpc } from "../surfaces/discord/workspaceLink.ts";
import { PersonalSession, type ChatSession, type ChatSessionFactory } from "./personalSession.ts";
import { readWorkspaceState } from "./state.ts";

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
}

function startServer(port: number): OrchestrationServer {
  const server = new OrchestrationServer({ port, onEvent: () => {}, secretGrants: { [SECRET]: { principalId: P, roles: ["workspace"] } } });
  return server;
}

async function startBot(store: WorkspaceLinkStore, dm: FakeDm, port = 0): Promise<Bot> {
  const server = startServer(port);
  const link = new WorkspaceLink({ principalId: P, store, ownerChannel: async () => dm, owner: () => ({ id: OWNER, name: "drk" }), timers: immediateTimers });
  const bot: Bot = { server, link, port: 0, deliverRequests: 0, kill: "none", messages: [] };
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
    sessions.push(s);
    return { session: s as unknown as ChatSession, sessionFile: s.file };
  };
  const ws: Workspace = {
    personal: null as unknown as PersonalSession,
    sessions,
    stateDir,
    client: null,
    pi: () => sessions.at(-1)!,
    connect(url, secret = SECRET) {
      const client = new OrchestrationClient({
        url,
        runnerId: `workspace-${P}`,
        kind: "pi-workspace",
        location: "workspace",
        ownerOnly: true,
        role: "workspace",
        secret,
        principalId: P,
        state: () => ws.personal.state,
        handlers: ws.personal.handlers(),
        onRegistered: () => ws.personal.onRegistered(),
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
      notify: (method, params) => ws.client?.notify(method, params),
      isConnected: () => ws.client?.connected ?? false,
    },
    resendIntervalMs: 200,
    now: () => NOW,
  });
  await ws.personal.start();
  cleanups.push(() => ws.personal.dispose());
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
    cursor: memCursor,
  };
  return { deps, inProcess, dm: (id, content) => handleOwnerDm(dm.message(id, content), deps) };
}

async function linked() {
  const dm = new FakeDm();
  const db = new Database(":memory:");
  applySchema(db);
  const store = new WorkspaceLinkStore(db);
  const bot = await startBot(store, dm);
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
    await handleWorkspaceStopButton(staleClick.interaction, { ownerId: OWNER, link: h.r.bot.link });
    expect(staleClick.editReplies).toEqual(["That turn already finished."]);
    expect(h.ws.pi().aborts).toBe(0);
    expect(h.ws.pi().isStreaming).toBe(true);

    const click = stopInteraction(current);
    await handleWorkspaceStopButton(click.interaction, { ownerId: OWNER, link: h.r.bot.link });
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
    const bad = new OrchestrationClient({ url: h.url(), runnerId: `workspace-${P}`, kind: "pi-workspace", role: "workspace", secret: "wrong", principalId: P, heartbeatMs: 0 });
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
    const bad = new OrchestrationClient({ url: h.url(), runnerId: `workspace-${P}`, kind: "pi-workspace", role: "workspace", secret: "wrong", principalId: P, heartbeatMs: 0 });
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
});
