import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { ChatDeliverParams, ChatEventParams, ChatMessageParams } from "../orchestration/contracts.ts";
import { PersonalSession, type ChatSession, type ChatSessionFactory, type ChatTransport } from "./personalSession.ts";
import { readWorkspaceState, writeWorkspaceState } from "./state.ts";

// Mirrors the Pi behaviour the host relies on: an idle prompt() awaits preflight before flipping
// isStreaming and then resolves only when the run ends; a streaming prompt() queues a steer.
class FakeSession {
  isStreaming = false;
  isCompacting = false;
  pendingMessageCount = 0;
  prompts: Array<{ text: string; options?: PromptOptions }> = [];
  steers: string[] = [];
  customs: Array<{ content: unknown; options: unknown }> = [];
  aborts = 0;
  disposed = false;
  private listeners = new Set<(e: AgentSessionEvent) => void>();
  private endRun: (() => void) | null = null;

  constructor(readonly file: string) {}

  subscribe(listener: (e: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: unknown): void {
    for (const l of this.listeners) l(e as AgentSessionEvent);
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.prompts.push({ text, options });
    if (this.isStreaming) {
      if (!options?.streamingBehavior) throw new Error("Agent is already processing");
      this.steers.push(text);
      options.preflightResult?.(true);
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
    options?.preflightResult?.(true);
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    await new Promise<void>((r) => (this.endRun = r));
  }

  finish(text: string, stopReason = "stop"): void {
    this.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } });
    this.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: false });
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0 } },
      },
    });
    this.isStreaming = false;
    this.emit({ type: "agent_settled" });
    this.endRun?.();
    this.endRun = null;
  }

  async abort(): Promise<void> {
    this.aborts++;
    if (this.isStreaming) this.finish("", "aborted");
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
}

class FakeTransport implements ChatTransport {
  requests: Array<{ method: string; params: unknown }> = [];
  notifications: Array<{ method: string; params: unknown }> = [];
  fail = false;
  onRequest?: (method: string, params: unknown) => void;

  request(method: string, params: unknown): Promise<unknown> {
    this.onRequest?.(method, params);
    this.requests.push({ method, params });
    return this.fail ? Promise.reject(new Error("link closed")) : Promise.resolve({});
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  delivered(): ChatDeliverParams[] {
    return this.requests.filter((r) => r.method === "chat/deliver").map((r) => r.params as ChatDeliverParams);
  }

  events(): ChatEventParams["ev"][] {
    return this.notifications.filter((n) => n.method === "chat/event").map((n) => (n.params as ChatEventParams).ev);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-session-"));
  dirs.push(d);
  return d;
}

function setup(opts: { stateDir?: string; factory?: ChatSessionFactory; fileExists?: (p: string) => boolean } = {}) {
  const stateDir = opts.stateDir ?? tempDir();
  const sessions: FakeSession[] = [];
  const factoryCalls: Array<string | null> = [];
  let n = 0;
  const factory: ChatSessionFactory =
    opts.factory ??
    (async ({ sessionFile }) => {
      factoryCalls.push(sessionFile);
      const s = new FakeSession(sessionFile ?? join(stateDir, `chat-${++n}.jsonl`));
      sessions.push(s);
      return { session: s as unknown as ChatSession, sessionFile: s.file };
    });
  const transport = new FakeTransport();
  let id = 0;
  const host = new PersonalSession({
    principalId: "drk",
    model: "test/model",
    stateDir,
    factory,
    transport,
    textDeltaMs: null,
    newId: () => `id-${++id}`,
    fileExists: opts.fileExists,
  });
  return { host, sessions, factoryCalls, transport, stateDir };
}

const msg = (messageId: string, text: string, extra: Partial<ChatMessageParams> = {}): ChatMessageParams => ({
  principalId: "drk",
  messageId,
  text,
  kind: "user",
  author: { id: "1", name: "drk" },
  ...extra,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PersonalSession routing", () => {
  test("idle message starts a turn; a message during the turn steers the same session", async () => {
    const { host, sessions } = setup();
    await host.start();
    expect(await host.handleMessage(msg("m1", "hi"))).toEqual({ accepted: true, mode: "prompt" });
    expect(host.state).toBe("streaming");
    expect(await host.handleMessage(msg("m2", "also this"))).toEqual({ accepted: true, mode: "steer" });
    const s = sessions[0];
    expect(s.prompts.map((p) => p.options?.streamingBehavior)).toEqual(["steer", "steer"]);
    expect(s.steers).toEqual(["also this"]);
  });

  test("two messages racing an idle session start one run, not two", async () => {
    const { host, sessions } = setup();
    await host.start();
    const [a, b] = await Promise.all([host.handleMessage(msg("m1", "one")), host.handleMessage(msg("m2", "two"))]);
    expect([a.mode, b.mode]).toEqual(["prompt", "steer"]);
    expect(sessions[0].steers).toEqual(["two"]);
  });

  test("voice messages carry the transcription marker", async () => {
    const { host, sessions } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "remind me", { voice: true }));
    expect(sessions[0].prompts[0].text).toBe("[voice message, transcribed] remind me");
  });

  test("a prompt waits out an in-progress compaction", async () => {
    const { host, sessions } = setup();
    await host.start();
    const s = sessions[0];
    s.isCompacting = true;
    const pending = host.handleMessage(msg("m1", "hi"));
    await tick();
    expect(s.prompts).toHaveLength(0);
    s.isCompacting = false;
    s.emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
    expect((await pending).mode).toBe("prompt");
  });
});

describe("PersonalSession idempotency", () => {
  test("a repeated messageId is a no-op duplicate, including across restarts", async () => {
    const stateDir = tempDir();
    const first = setup({ stateDir });
    await first.host.start();
    await first.host.handleMessage(msg("m1", "hi"));
    expect(await first.host.handleMessage(msg("m1", "hi"))).toEqual({ accepted: true, mode: "duplicate" });
    expect(first.sessions[0].prompts).toHaveLength(1);

    const second = setup({ stateDir });
    await second.host.start();
    expect(await second.host.handleMessage(msg("m1", "hi"))).toEqual({ accepted: true, mode: "duplicate" });
    expect(second.sessions[0].prompts).toHaveLength(0);
  });

  test("a message whose prompt fails is not remembered, so a retry goes through", async () => {
    const { host, sessions } = setup();
    await host.start();
    const s = sessions[0];
    const original = s.prompt.bind(s);
    s.prompt = async () => {
      throw new Error("no api key");
    };
    await expect(host.handleMessage(msg("m1", "hi"))).rejects.toThrow("no api key");
    s.prompt = original;
    expect((await host.handleMessage(msg("m1", "hi"))).mode).toBe("prompt");
  });
});

describe("PersonalSession state.json", () => {
  test("creates a new session and records it when there is no state", async () => {
    const { host, factoryCalls, stateDir } = setup();
    await host.start();
    expect(factoryCalls).toEqual([null]);
    expect(readWorkspaceState(stateDir)).toEqual({ chatSessionFile: host.currentSessionFile });
  });

  test("reopens the recorded session file when it exists", async () => {
    const stateDir = tempDir();
    const file = join(stateDir, "existing.jsonl");
    writeFileSync(file, "");
    writeWorkspaceState(stateDir, { chatSessionFile: file });
    const { host, factoryCalls } = setup({ stateDir });
    await host.start();
    expect(factoryCalls).toEqual([file]);
    expect(host.currentSessionFile).toBe(file);
  });

  test("creates a new session when the recorded file is gone", async () => {
    const stateDir = tempDir();
    writeWorkspaceState(stateDir, { chatSessionFile: join(stateDir, "gone.jsonl") });
    const { host, factoryCalls } = setup({ stateDir });
    await host.start();
    expect(factoryCalls).toEqual([null]);
    expect(readWorkspaceState(stateDir)?.chatSessionFile).toBe(host.currentSessionFile);
  });
});

describe("PersonalSession outbox", () => {
  test("the reply is on disk before chat/deliver is sent, and resent after re-register until acked", async () => {
    const { host, sessions, transport, stateDir } = setup();
    await host.start();
    const outboxPath = join(stateDir, "outbox.jsonl");
    const onDiskAtSend: boolean[] = [];
    transport.onRequest = (method, params) => {
      if (method === "chat/deliver") {
        onDiskAtSend.push(existsSync(outboxPath) && readFileSync(outboxPath, "utf8").includes((params as ChatDeliverParams).outboxId));
      }
    };
    transport.fail = true;
    await host.handleMessage(msg("m1", "hi"));
    sessions[0].finish("hello there");
    await tick();

    const [entry] = transport.delivered();
    expect(entry).toMatchObject({ principalId: "drk", kind: "reply", text: "hello there", replyTo: "m1" });
    expect(entry.usage).toEqual({ model: "test/model", inputTokens: 100, outputTokens: 20, cacheRead: 50, contextPct: 10 });
    expect(onDiskAtSend).toEqual([true]);

    transport.fail = false;
    host.resendUnacked();
    expect(transport.delivered().map((d) => d.outboxId)).toEqual([entry.outboxId, entry.outboxId]);

    // A restarted host still holds the unacked entry.
    const restarted = setup({ stateDir });
    restarted.host.resendUnacked();
    expect(restarted.transport.delivered().map((d) => d.outboxId)).toEqual([entry.outboxId]);

    expect(host.handleAck(entry.outboxId)).toEqual({});
    host.resendUnacked();
    expect(transport.delivered()).toHaveLength(2);
    const afterAck = setup({ stateDir });
    afterAck.host.resendUnacked();
    expect(afterAck.transport.delivered()).toHaveLength(0);
  });

  test("NO_REPLY and empty replies are not delivered, but the turn still ends", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "note this"));
    sessions[0].finish("  NO_REPLY \n");
    await host.handleMessage(msg("m2", "and this"));
    sessions[0].finish("");
    await tick();
    expect(transport.delivered()).toHaveLength(0);
    expect(transport.events().filter((e) => e.type === "turn_end")).toHaveLength(2);
  });

  test("live events map turn and tool boundaries", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "hi"));
    sessions[0].finish("done");
    await tick();
    expect(transport.events()).toEqual([
      { type: "turn_start" },
      { type: "tool_start", name: "bash", summary: "ls -la" },
      { type: "tool_end", name: "bash", ok: true },
      { type: "turn_end", aborted: false },
    ]);
    const turnIds = new Set(transport.notifications.map((n) => (n.params as ChatEventParams).turnId));
    expect(turnIds.size).toBe(1);
  });
});

describe("PersonalSession chat/abort", () => {
  test("aborts the running turn without replacing or disposing the session", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "long job"));
    expect(await host.handleAbort()).toEqual({ aborted: true });
    const s = sessions[0];
    expect(s.aborts).toBe(1);
    expect(s.disposed).toBe(false);
    expect(sessions).toHaveLength(1);
    expect(transport.events().at(-1)).toEqual({ type: "turn_end", aborted: true });
    expect(transport.delivered()).toHaveLength(0);
    expect((await host.handleMessage(msg("m2", "next"))).mode).toBe("prompt");
    expect(s.prompts).toHaveLength(2);
  });

  test("reports aborted:false when idle", async () => {
    const { host } = setup();
    await host.start();
    expect(await host.handleAbort()).toEqual({ aborted: false });
  });
});

describe("PersonalSession chat/new", () => {
  test("holds messages that arrive during the reset and replays them into the new session", async () => {
    const stateDir = tempDir();
    const sessions: FakeSession[] = [];
    let release: (() => void) | null = null;
    const factory: ChatSessionFactory = async ({ sessionFile }) => {
      if (sessions.length > 0) await new Promise<void>((r) => (release = r));
      const s = new FakeSession(sessionFile ?? join(stateDir, `chat-${sessions.length + 1}.jsonl`));
      sessions.push(s);
      return { session: s as unknown as ChatSession, sessionFile: s.file };
    };
    const { host } = setup({ stateDir, factory });
    await host.start();
    await host.handleMessage(msg("m1", "old convo"));
    const old = sessions[0];

    const reset = host.handleNew();
    await tick();
    expect(host.isResetting).toBe(true);
    expect(old.aborts).toBe(1);
    expect(old.disposed).toBe(true);

    const held = host.handleMessage(msg("m2", "first in new"));
    await tick();
    expect(old.prompts).toHaveLength(1);

    release!();
    const { sessionFile } = await reset;
    expect(sessionFile).toBe(join(stateDir, "chat-2.jsonl"));
    expect(readWorkspaceState(stateDir)).toEqual({ chatSessionFile: sessionFile });
    expect((await held).mode).toBe("prompt");
    expect(sessions[1].prompts.map((p) => p.text)).toEqual(["first in new"]);
    expect(host.isResetting).toBe(false);
  });
});

describe("PersonalSession context messages", () => {
  test("appended without a turn when idle; buffered until settle during a turn", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    expect(await host.handleMessage(msg("c1", "offline exchange A", { kind: "context" }))).toEqual({ accepted: true, mode: "context" });
    expect(s.customs.map((c) => c.content)).toEqual(["offline exchange A"]);
    expect(s.prompts).toHaveLength(0);

    await host.handleMessage(msg("m1", "hi"));
    await host.handleMessage(msg("c2", "offline exchange B", { kind: "context" }));
    expect(s.customs).toHaveLength(1);
    s.finish("reply");
    await tick();
    expect(s.customs.map((c) => c.content)).toEqual(["offline exchange A", "offline exchange B"]);
    expect(s.customs[1].options).toEqual({ triggerTurn: false });
    expect(transport.delivered()).toHaveLength(1);
  });
});
