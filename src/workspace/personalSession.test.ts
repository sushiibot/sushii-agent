import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { ChatDeliverParams, ChatEventParams, ChatMessageParams } from "../orchestration/contracts.ts";
import { PersonalSession, type ChatSession, type ChatSessionFactory, type ChatTransport } from "./personalSession.ts";
import { readWorkspaceState, writeWorkspaceState } from "./state.ts";

// Mirrors the Pi 0.84 behaviour the host relies on (core/agent-session.js, pi-agent-core agent-loop.js):
// - an idle prompt() awaits preflight, flips isStreaming, emits the user message, and resolves when the run settles;
// - a streaming prompt() queues a steer, which the loop drains (a user message_start each) before a normal finish;
// - abort() skips the drain, and with steers still queued Pi continues on them, so abort() waits out that run;
// - clearQueue() empties the steer queue and returns it.
class FakeSession {
  isStreaming = false;
  isCompacting = false;
  prompts: Array<{ text: string; options?: PromptOptions }> = [];
  steers: string[] = [];
  queue: string[] = [];
  customs: Array<{ content: unknown; options: unknown }> = [];
  aborts = 0;
  disposed = false;
  private listeners = new Set<(e: AgentSessionEvent) => void>();
  private idleWaiters: Array<() => void> = [];

  constructor(readonly file: string) {}

  get pendingMessageCount(): number {
    return this.queue.length;
  }

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
      this.queue.push(text);
      options.preflightResult?.(true);
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
    options?.preflightResult?.(true);
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    this.emitUser(text);
    await this.waitForIdle();
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = this.queue;
    this.queue = [];
    return { steering, followUp: [] };
  }

  finish(text: string, stopReason = "stop", errorMessage?: string): void {
    this.drain();
    this.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } });
    this.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: false });
    this.endMessage(text, stopReason, errorMessage);
    this.settle();
  }

  /** A steer queued after the loop's last drain: the run settles with it still pending. */
  settleStranded(text: string): void {
    this.endMessage(text, "stop");
    this.settle();
  }

  async abort(): Promise<void> {
    this.aborts++;
    if (!this.isStreaming) return;
    this.endMessage("", "aborted");
    if (this.queue.length === 0) return this.settle();
    this.drain(); // _handlePostAgentRun sees queued messages and continues
    await this.waitForIdle();
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

  private emitUser(text: string): void {
    this.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
  }

  private drain(): void {
    for (const text of this.queue.splice(0)) this.emitUser(text);
  }

  private endMessage(text: string, stopReason: string, errorMessage?: string): void {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0 } },
      },
    });
  }

  private settle(): void {
    this.isStreaming = false;
    this.emit({ type: "agent_settled" });
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private waitForIdle(): Promise<void> {
    return this.isStreaming ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
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

const TIMED_OUT = Symbol("timed out");
/** Races a call that must not wait on a continuation run; the fake only ends such a run on finish(). */
const within = <T>(p: Promise<T>, ms = 100): Promise<T | typeof TIMED_OUT> =>
  Promise.race([p, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);

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

  test("an id is recorded as seen only once accepted, but an in-flight resend is still a duplicate", async () => {
    const stateDir = tempDir();
    const { host, sessions } = setup({ stateDir });
    await host.start();
    const s = sessions[0];
    s.isCompacting = true;
    const pending = host.handleMessage(msg("m1", "hi"));
    await tick();
    expect(await host.handleMessage(msg("m1", "hi"))).toEqual({ accepted: true, mode: "duplicate" });

    // A host restarted before acceptance must not treat the bot's retry as a duplicate.
    const restarted = setup({ stateDir });
    await restarted.host.start();
    expect((await restarted.host.handleMessage(msg("m1", "hi"))).mode).toBe("prompt");

    s.isCompacting = false;
    s.emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
    expect((await pending).mode).toBe("prompt");
    expect(await host.handleMessage(msg("m1", "hi"))).toEqual({ accepted: true, mode: "duplicate" });
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

  test("drops a queued steer instead of running it, so the abort returns and nothing is delivered", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "long job"));
    expect((await host.handleMessage(msg("m2", "and also"))).mode).toBe("steer");
    const s = sessions[0];

    expect(await within(host.handleAbort())).toEqual({ aborted: true });
    expect(s.isStreaming).toBe(false);
    expect(s.pendingMessageCount).toBe(0);
    await tick();
    expect(transport.delivered()).toHaveLength(0);
    expect(transport.events().filter((e) => e.type === "turn_end")).toEqual([{ type: "turn_end", aborted: true }]);
    expect(s.prompts).toHaveLength(2);
  });

  test("reports aborted:false when idle", async () => {
    const { host } = setup();
    await host.start();
    expect(await host.handleAbort()).toEqual({ aborted: false });
  });
});

describe("PersonalSession stranded steers", () => {
  test("a steer still queued at settle is re-prompted, and each reply points at the message it answers", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "first"));
    expect((await host.handleMessage(msg("m2", "second"))).mode).toBe("steer");
    const s = sessions[0];

    s.settleStranded("answer to first");
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.delivered().map((d) => [d.text, d.replyTo])).toEqual([["answer to first", "m1"]]);
    expect(s.pendingMessageCount).toBe(0);
    expect(s.isStreaming).toBe(true);
    expect(s.prompts.map((p) => p.text)).toEqual(["first", "second", "second"]);

    s.finish("answer to second");
    await tick();
    expect(transport.delivered().map((d) => [d.text, d.replyTo])).toEqual([
      ["answer to first", "m1"],
      ["answer to second", "m2"],
    ]);
  });
});

describe("PersonalSession failures", () => {
  test("an errored run delivers a one-line failure notice instead of its partial text", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "hi"));
    sessions[0].finish("partial answ", "error", "provider returned 502\nretry budget exhausted");
    await tick();
    expect(transport.delivered()).toMatchObject([{ kind: "reply", text: "⚠️ Turn failed: provider returned 502", replyTo: "m1" }]);
    expect(transport.events().at(-1)).toEqual({ type: "turn_end", aborted: false });
  });

  test("a prompt rejected after acceptance delivers a failure notice", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    s.prompt = async (_text, options) => {
      options?.preflightResult?.(true);
      throw new Error("extension blew up");
    };
    expect((await host.handleMessage(msg("m1", "hi"))).mode).toBe("prompt");
    await tick();
    expect(transport.delivered()).toMatchObject([{ kind: "reply", text: "⚠️ Turn failed: extension blew up", replyTo: "m1" }]);
  });
});

describe("PersonalSession principal", () => {
  test("chat verbs for another principal are rejected", async () => {
    const { host, sessions } = setup();
    await host.start();
    const handlers = host.handlers();
    await expect(handlers["chat/message"]({ ...msg("m1", "hi"), principalId: "mallory" })).rejects.toThrow("principal mismatch");
    await expect(handlers["chat/abort"]({ principalId: "mallory" })).rejects.toThrow("principal mismatch");
    await expect(handlers["chat/new"]({ principalId: "mallory" })).rejects.toThrow("principal mismatch");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].prompts).toHaveLength(0);
    expect((await handlers["chat/message"](msg("m1", "hi"))) as unknown).toEqual({ accepted: true, mode: "prompt" });
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
    expect(old.disposed).toBe(false);

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
    expect(old.disposed).toBe(true);
  });

  test("a steer queued on the old session is dropped, not answered from the retired conversation", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "old convo"));
    await host.handleMessage(msg("m2", "old steer"));
    const old = sessions[0];
    expect(old.pendingMessageCount).toBe(1);

    const result = await within(host.handleNew());
    expect(result).not.toBe(TIMED_OUT);
    expect(old.isStreaming).toBe(false);
    expect(old.pendingMessageCount).toBe(0);
    expect(transport.delivered()).toHaveLength(0);
    expect(sessions).toHaveLength(2);
    expect(host.currentSessionFile).toBe(sessions[1].file);
  });

  test("a factory failure keeps the old session attached and usable", async () => {
    const stateDir = tempDir();
    const sessions: FakeSession[] = [];
    const factory: ChatSessionFactory = async ({ sessionFile }) => {
      if (sessions.length > 0) throw new Error("network down");
      const s = new FakeSession(sessionFile ?? join(stateDir, "chat-1.jsonl"));
      sessions.push(s);
      return { session: s as unknown as ChatSession, sessionFile: s.file };
    };
    const { host, transport } = setup({ stateDir, factory });
    await host.start();
    const before = readWorkspaceState(stateDir);

    await expect(host.handleNew()).rejects.toThrow("network down");
    const old = sessions[0];
    expect(old.disposed).toBe(false);
    expect(host.isResetting).toBe(false);
    expect(host.currentSessionFile).toBe(old.file);
    expect(readWorkspaceState(stateDir)).toEqual(before);

    expect((await host.handleMessage(msg("m1", "still there?"))).mode).toBe("prompt");
    old.finish("yes");
    await tick();
    expect(transport.delivered().map((d) => d.text)).toEqual(["yes"]);
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
