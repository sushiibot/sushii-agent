import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { ChatDeliverParams, ChatEventParams, ChatMessageParams } from "../orchestration/contracts.ts";
import { PersonalSession, formatUserText, messageHeader, type ChatSession, type ChatSessionFactory, type ChatTransport } from "./personalSession.ts";
import { readWorkspaceState, writeWorkspaceState } from "./state.ts";

// Mirrors the Pi 0.84 behaviour the host relies on (core/agent-session.js, pi-agent-core agent-loop.js):
// - an idle prompt() awaits preflight, flips isStreaming, emits the user message, and resolves when its run settles;
// - a streaming prompt() queues a steer (after any input-handler await), which the loop drains before a normal finish;
// - abort() ends the run asynchronously; with steers still queued by then, Pi continues on them and abort() waits it out;
// - settling clears isStreaming, then awaits extension handlers (settleGate) before emitting agent_settled, and
//   resolves idle waiters only if no new run started in that gap;
// - clearQueue() empties the steer queue and returns it.
class FakeSession {
  isStreaming = false;
  isCompacting = false;
  prompts: Array<{ text: string; options?: PromptOptions }> = [];
  steers: string[] = [];
  queue: string[] = [];
  customs: Array<{ content: unknown; options: unknown }> = [];
  messages: Array<{ role: string }> = [];
  aborts = 0;
  disposed = false;
  settleGate: Promise<void> | null = null;
  steerGate: Promise<void> | null = null;
  abortGate: Promise<void> | null = null;
  rejectAfterRun: Error | null = null;
  private listeners = new Set<(e: AgentSessionEvent) => void>();
  private idleWaiters: Array<() => void> = [];
  private runDone: (() => void) | null = null;

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
    if (this.isStreaming && this.steerGate) await this.steerGate;
    if (this.isStreaming) {
      if (!options?.streamingBehavior) throw new Error("Agent is already processing");
      this.steers.push(text);
      this.queue.push(text);
      options.preflightResult?.("queued");
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
    options?.preflightResult?.("started");
    this.isStreaming = true;
    const done = new Promise<void>((r) => (this.runDone = r));
    this.emit({ type: "agent_start" });
    this.emitUser(text);
    await done;
    if (this.rejectAfterRun) throw this.rejectAfterRun;
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
    void this.settle();
  }

  /** A steer queued after the loop's last drain: the run settles with it still pending. */
  settleStranded(text: string): void {
    this.endMessage(text, "stop");
    void this.settle();
  }

  async abort(): Promise<void> {
    this.aborts++;
    if (!this.isStreaming) return;
    await (this.abortGate ?? Promise.resolve());
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
    this.messages.push({ role: "assistant" });
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

  private async settle(): Promise<void> {
    const done = this.runDone;
    this.runDone = null;
    this.isStreaming = false;
    await (this.settleGate ?? Promise.resolve());
    this.emit({ type: "agent_settled" });
    done?.();
    if (!this.isStreaming) for (const w of this.idleWaiters.splice(0)) w();
  }

  private waitForIdle(): Promise<void> {
    return this.isStreaming ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }
}

class FakeTransport implements ChatTransport {
  requests: Array<{ method: string; params: unknown }> = [];
  notifications: Array<{ method: string; params: unknown }> = [];
  fail = false;
  connected = true;
  onRequest?: (method: string, params: unknown) => void;
  respond?: (method: string, params: unknown) => Promise<unknown>;

  request(method: string, params: unknown): Promise<unknown> {
    this.onRequest?.(method, params);
    this.requests.push({ method, params });
    if (this.respond) return this.respond(method, params);
    return this.fail ? Promise.reject(new Error("link closed")) : Promise.resolve({});
  }

  isConnected(): boolean {
    return this.connected;
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

function setup(
  opts: { stateDir?: string; factory?: ChatSessionFactory; fileExists?: (p: string) => boolean; resendIntervalMs?: number } = {},
) {
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
    resendIntervalMs: opts.resendIntervalMs,
    now: () => NOW,
  });
  return { host, sessions, factoryCalls, transport, stateDir };
}

const NOW = new Date("2026-09-29T12:00:00Z");
/** The prompt text for a message whose (test) id isn't a snowflake, so it carries the receipt time. */
const stamped = (messageId: string, text: string) => `[discord:${messageId} 2026-09-29 12:00 UTC]\n${text}`;

const DM_ORIGIN = { surface: "discord", conversationId: "dm" };

const msg = (messageId: string, text: string, extra: Partial<ChatMessageParams> = {}): ChatMessageParams => ({
  principalId: "drk",
  origin: DM_ORIGIN,
  messageId,
  text,
  kind: "user",
  author: { id: "1", name: "drk" },
  ...extra,
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

const compactionEnd = { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false };

const TIMED_OUT = Symbol("timed out");
/** Races a call that must not wait on a continuation run; the fake only ends such a run on finish(). */
const within = <T>(p: Promise<T>, ms = 100): Promise<T | typeof TIMED_OUT> =>
  Promise.race([p, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);

describe("message header", () => {
  // Discord's documented example snowflake: sent 2016-04-30 11:18:25.796 UTC.
  const SNOWFLAKE = "175928847299117063";

  test("a Discord message gets its surface and its send time, not the receipt time", () => {
    expect(messageHeader(SNOWFLAKE, NOW)).toBe(`[discord:${SNOWFLAKE} 2016-04-30 11:18 UTC]`);
    expect(messageHeader(SNOWFLAKE, NOW, { surface: "discord" })).toBe(`[discord:${SNOWFLAKE} 2016-04-30 11:18 UTC]`);
  });

  test("another surface gets its own name and the receipt time", () => {
    expect(messageHeader("ev123", NOW, { surface: "buzz" })).toBe("[buzz:ev123 2026-09-29 12:00 UTC]");
    expect(messageHeader("1727000000.000100", NOW, { surface: "slack" })).toBe("[slack:1727000000.000100 2026-09-29 12:00 UTC]");
  });

  test("host-minted ids appear bare, so they can't pass for a surface message", () => {
    expect(messageHeader("inbox:7", NOW)).toBe("[inbox:7 2026-09-29 12:00 UTC]");
    expect(messageHeader("wsask:abc", NOW)).toBe("[wsask:abc 2026-09-29 12:00 UTC]");
  });

  test("the voice marker sits inside the header; attachments follow the text", () => {
    const text = formatUserText(
      {
        messageId: SNOWFLAKE,
        text: "remind me",
        voice: true,
        origin: { surface: "discord", conversationId: "dm" },
        attachments: [{ name: "a.png", contentType: "image/png", url: "https://x/a.png" }],
      },
      NOW,
    );
    expect(text).toBe(`[discord:${SNOWFLAKE} 2016-04-30 11:18 UTC, voice message, transcribed]\nremind me\n[attachment: a.png (image/png) https://x/a.png]`);
  });

  test("no id: no header, but a voice message is still marked", () => {
    expect(formatUserText({ messageId: "", text: "hi" }, NOW)).toBe("hi");
    expect(formatUserText({ messageId: "", text: "hi", voice: true }, NOW)).toBe("[voice message, transcribed]\nhi");
  });
});

describe("PersonalSession routing", () => {
  test("idle message starts a turn; a message during the turn steers the same session", async () => {
    const { host, sessions } = setup();
    await host.start();
    expect(await host.handleMessage(msg("m1", "hi"))).toEqual({ accepted: true, mode: "prompt" });
    expect(host.state).toBe("streaming");
    expect(await host.handleMessage(msg("m2", "also this"))).toEqual({ accepted: true, mode: "steer" });
    const s = sessions[0];
    expect(s.prompts.map((p) => p.options?.streamingBehavior)).toEqual(["steer", "steer"]);
    expect(s.steers).toEqual([stamped("m2", "also this")]);
  });

  test("two messages racing an idle session start one run, not two", async () => {
    const { host, sessions } = setup();
    await host.start();
    const [a, b] = await Promise.all([host.handleMessage(msg("m1", "one")), host.handleMessage(msg("m2", "two"))]);
    expect([a.mode, b.mode]).toEqual(["prompt", "steer"]);
    expect(sessions[0].steers).toEqual([stamped("m2", "two")]);
  });

  test("voice messages carry the transcription marker in the header", async () => {
    const { host, sessions } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "remind me", { voice: true }));
    expect(sessions[0].prompts[0].text).toBe("[discord:m1 2026-09-29 12:00 UTC, voice message, transcribed]\nremind me");
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

  test("an id is recorded as seen only once accepted; a resend of a held message waits for it and is a duplicate", async () => {
    const stateDir = tempDir();
    const { host, sessions } = setup({ stateDir });
    await host.start();
    const s = sessions[0];
    s.isCompacting = true;
    const pending = host.handleMessage(msg("m1", "hi"));
    await tick();
    const retry = host.handleMessage(msg("m1", "hi"));

    // A host restarted before acceptance must not treat the bot's retry as a duplicate.
    const restarted = setup({ stateDir });
    await restarted.host.start();
    expect((await restarted.host.handleMessage(msg("m1", "hi"))).mode).toBe("prompt");

    s.isCompacting = false;
    s.emit(compactionEnd);
    expect((await pending).mode).toBe("prompt");
    expect(await retry).toEqual({ accepted: true, mode: "duplicate" });
    expect(s.prompts).toHaveLength(1);
    expect(await host.handleMessage(msg("m1", "hi"))).toEqual({ accepted: true, mode: "duplicate" });
  });

  test("a resend of a held message fails with the original, so a later retry still delivers it", async () => {
    const { host, sessions } = setup();
    await host.start();
    const s = sessions[0];
    const original = s.prompt.bind(s);
    s.prompt = async () => {
      throw new Error("no api key");
    };
    s.isCompacting = true;
    const first = host.handleMessage(msg("m1", "hi")).catch((e: Error) => e);
    await tick();
    const retry = host.handleMessage(msg("m1", "hi")).catch((e: Error) => e);
    s.isCompacting = false;
    s.emit(compactionEnd);
    expect(String(await first)).toContain("no api key");
    expect(String(await retry)).toContain("no api key");

    s.prompt = original;
    expect((await host.handleMessage(msg("m1", "hi"))).mode).toBe("prompt");
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
    expect(entry.turnId).toBe((transport.notifications[0].params as ChatEventParams).turnId);
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

  test("unacked entries are resent on an interval in order, skipping any whose send is still unanswered", async () => {
    const { host, sessions, transport } = setup({ resendIntervalMs: 20 });
    await host.start();
    const pending = new Map<string, () => void>();
    transport.respond = (_method, params) => {
      const id = (params as ChatDeliverParams).outboxId;
      if (pending.size === 0 && !transport.delivered().slice(0, -1).some((d) => d.outboxId === id)) {
        return new Promise((resolve) => pending.set(id, () => resolve({})));
      }
      return Promise.reject(new Error("bot error"));
    };
    await host.handleMessage(msg("m1", "one"));
    sessions[0].finish("first");
    await tick();
    await host.handleMessage(msg("m2", "two"));
    sessions[0].finish("second");
    await tick();
    const [a, b] = transport.delivered().map((d) => d.outboxId);

    host.onRegistered();
    await sleep(50);
    const sent = () => transport.delivered().map((d) => d.outboxId);
    // a's first send is still unanswered, so only b is retried.
    expect(sent().filter((id) => id === a)).toHaveLength(1);
    expect(sent().filter((id) => id === b).length).toBeGreaterThan(2);

    pending.get(a)!();
    await tick();
    transport.respond = () => Promise.resolve({});
    const before = sent().length;
    await sleep(30);
    const retried = sent().slice(before);
    expect(retried.slice(0, 2)).toEqual([a, b]);

    host.handleAck(a);
    host.handleAck(b);
    transport.connected = false;
    const settled = sent().length;
    await sleep(50);
    expect(sent()).toHaveLength(settled);
    await host.dispose();
  });

  test("no resend runs while the link is down", async () => {
    const { host, sessions, transport } = setup({ resendIntervalMs: 10 });
    await host.start();
    transport.fail = true;
    await host.handleMessage(msg("m1", "one"));
    sessions[0].finish("first");
    await tick();
    host.onRegistered();
    transport.connected = false;
    const count = transport.delivered().length;
    await sleep(40);
    expect(transport.delivered()).toHaveLength(count);
    await host.dispose();
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

  test("a steer that lands while the abort is in flight is dropped, not continued", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "long job"));
    const s = sessions[0];
    const steer = gate();
    const abortLands = gate();
    s.steerGate = steer.promise;
    s.abortGate = abortLands.promise;

    const m2 = host.handleMessage(msg("m2", "and also"));
    await tick();
    const abort = host.handleAbort();
    await tick();
    steer.open();
    await tick();
    abortLands.open();

    expect(await within(abort)).toEqual({ aborted: true });
    expect((await m2).mode).toBe("steer");
    expect(s.isStreaming).toBe(false);
    expect(s.pendingMessageCount).toBe(0);
    await tick();
    expect(transport.delivered()).toHaveLength(0);
  });

  test("an abort naming a finished turn is a no-op; one naming the current turn stops it", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    await host.handleMessage(msg("m1", "first"));
    s.finish("done");
    await tick();
    const staleTurn = transport.delivered()[0].turnId!;

    await host.handleMessage(msg("m2", "second"));
    expect(await host.handleAbort(staleTurn)).toEqual({ aborted: false });
    expect(s.aborts).toBe(0);
    expect(s.isStreaming).toBe(true);

    const currentTurn = (transport.notifications.at(-1)!.params as ChatEventParams).turnId;
    expect(currentTurn).not.toBe(staleTurn);
    const handlers = host.handlers();
    expect(await handlers["chat/abort"]({ principalId: "drk", turnId: currentTurn })).toEqual({ aborted: true });
    expect(s.isStreaming).toBe(false);
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
    expect(s.prompts.map((p) => p.text)).toEqual([stamped("m1", "first"), stamped("m2", "second"), stamped("m2", "second")]);

    s.finish("answer to second");
    await tick();
    expect(transport.delivered().map((d) => [d.text, d.replyTo])).toEqual([
      ["answer to first", "m1"],
      ["answer to second", "m2"],
    ]);
  });
});

describe("PersonalSession settle gap", () => {
  test("a message arriving after the run ends but before agent_settled starts its own turn and gets its own reply", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    await host.handleMessage(msg("m1", "first"));
    const settled = gate();
    s.settleGate = settled.promise;
    s.finish("answer to first");
    expect(s.isStreaming).toBe(false);

    const m2 = host.handleMessage(msg("m2", "second"));
    await sleep(20);
    expect(s.prompts).toHaveLength(1);
    s.settleGate = null;
    settled.open();
    expect((await m2).mode).toBe("prompt");
    s.finish("answer to second");
    await tick();

    const delivered = transport.delivered();
    expect(delivered.map((d) => [d.text, d.replyTo])).toEqual([
      ["answer to first", "m1"],
      ["answer to second", "m2"],
    ]);
    expect(delivered[0].turnId).not.toBe(delivered[1].turnId);
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
    expect(transport.delivered()[0].turnId).toBe((transport.notifications[0].params as ChatEventParams).turnId);
    expect(transport.events().at(-1)).toEqual({ type: "turn_end", aborted: false });
  });

  test("a rejection after a run that already replied does not add a failure notice", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    s.rejectAfterRun = new Error("Cannot continue from message role: assistant");
    await host.handleMessage(msg("m1", "hi"));
    s.finish("the answer");
    await sleep(10);
    expect(transport.delivered().map((d) => d.text)).toEqual(["the answer"]);
  });

  test("a rejection after an aborted run stays silent", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    s.rejectAfterRun = new Error("Cannot continue from message role: assistant");
    await host.handleMessage(msg("m1", "hi"));
    await host.handleAbort();
    await sleep(10);
    expect(transport.delivered()).toHaveLength(0);
  });

  test("a rejection after a run that said nothing delivers a notice for that turn", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    s.rejectAfterRun = new Error("No messages to continue from");
    await host.handleMessage(msg("m1", "hi"));
    s.finish("");
    await sleep(10);
    const turnId = (transport.notifications[0].params as ChatEventParams).turnId;
    expect(transport.delivered()).toMatchObject([{ text: "⚠️ Turn failed: No messages to continue from", replyTo: "m1", turnId }]);
  });

  test("a prompt rejected after acceptance delivers a failure notice", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const s = sessions[0];
    s.prompt = async (_text, options) => {
      options?.preflightResult?.("started");
      throw new Error("extension blew up");
    };
    expect((await host.handleMessage(msg("m1", "hi"))).mode).toBe("prompt");
    await tick();
    expect(transport.delivered()).toMatchObject([{ kind: "reply", text: "⚠️ Turn failed: extension blew up", replyTo: "m1" }]);
    expect(transport.delivered()[0].turnId).toBeUndefined();
  });

  test("chat text reaches Pi literally, without template or command expansion", async () => {
    const { host, sessions } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "/skill:deploy now"));
    expect(sessions[0].prompts[0].options?.expandPromptTemplates).toBe(false);
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
    expect(sessions[1].prompts.map((p) => p.text)).toEqual([stamped("m2", "first in new")]);
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

  test("a run that finished but hadn't settled when chat/new ran ends as aborted and delivers nothing", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    const old = sessions[0];
    await host.handleMessage(msg("m1", "old convo"));
    const settled = gate();
    old.settleGate = settled.promise;
    old.finish("old answer");

    await host.handleNew();
    settled.open();
    await tick();
    expect(transport.delivered()).toHaveLength(0);
    expect(transport.events().filter((e) => e.type === "turn_end")).toEqual([{ type: "turn_end", aborted: true }]);
  });

  test("context buffered during the old conversation's run is not carried into the new session", async () => {
    const { host, sessions } = setup();
    await host.start();
    const old = sessions[0];
    await host.handleMessage(msg("m1", "old convo"));
    expect((await host.handleMessage(msg("c1", "old context", { kind: "context" }))).mode).toBe("context");

    await host.handleNew();
    const fresh = sessions[1];
    await host.handleMessage(msg("m2", "new convo"));
    fresh.finish("hi");
    await sleep(10);
    expect(fresh.customs).toHaveLength(0);
    expect(old.customs).toHaveLength(0);
    expect(await host.handleMessage(msg("c1", "old context", { kind: "context" }))).toEqual({ accepted: true, mode: "duplicate" });
    expect(fresh.customs).toHaveLength(0);
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
    expect(s.customs.map((c) => c.content)).toEqual([stamped("c1", "offline exchange A")]);
    expect(s.prompts).toHaveLength(0);

    await host.handleMessage(msg("m1", "hi"));
    await host.handleMessage(msg("c2", "offline exchange B", { kind: "context" }));
    expect(s.customs).toHaveLength(1);
    s.finish("reply");
    await tick();
    expect(s.customs.map((c) => c.content)).toEqual([stamped("c1", "offline exchange A"), stamped("c2", "offline exchange B")]);
    expect(s.customs[1].options).toEqual({ triggerTurn: false });
    expect(transport.delivered()).toHaveLength(1);
  });

  test("buffered context is not recorded as seen until it is appended", async () => {
    const stateDir = tempDir();
    const { host, sessions } = setup({ stateDir });
    await host.start();
    const s = sessions[0];
    await host.handleMessage(msg("m1", "hi"));
    s.finish("earlier reply");
    await tick();
    await host.handleMessage(msg("m2", "again"));
    await host.handleMessage(msg("c1", "offline exchange", { kind: "context" }));
    expect(await host.handleMessage(msg("c1", "offline exchange", { kind: "context" }))).toEqual({ accepted: true, mode: "duplicate" });

    // A crash while it sits in the buffer: the bot's retry must be taken.
    const restarted = setup({ stateDir });
    await restarted.host.start();
    expect((await restarted.host.handleMessage(msg("c1", "offline exchange", { kind: "context" }))).mode).toBe("context");

    s.finish("reply");
    await tick();
    expect(s.customs.map((c) => c.content)).toEqual([stamped("c1", "offline exchange")]);
    const later = setup({ stateDir });
    await later.host.start();
    expect((await later.host.handleMessage(msg("c1", "offline exchange", { kind: "context" }))).mode).toBe("duplicate");
  });

  test("context appended to a session with no reply on disk yet is recorded as seen only after the first reply", async () => {
    const stateDir = tempDir();
    const { host, sessions } = setup({ stateDir });
    await host.start();
    const s = sessions[0];
    await host.handleMessage(msg("c1", "offline exchange", { kind: "context" }));
    expect(s.customs).toHaveLength(1);
    expect(await host.handleMessage(msg("c1", "offline exchange", { kind: "context" }))).toEqual({ accepted: true, mode: "duplicate" });
    const beforeReply = setup({ stateDir });
    await beforeReply.host.start();
    expect((await beforeReply.host.handleMessage(msg("c1", "offline exchange", { kind: "context" }))).mode).toBe("context");

    await host.handleMessage(msg("m1", "hi"));
    s.finish("reply");
    await tick();
    const afterReply = setup({ stateDir });
    await afterReply.host.start();
    expect((await afterReply.host.handleMessage(msg("c1", "offline exchange", { kind: "context" }))).mode).toBe("duplicate");
  });

  test("context buffered during a run lands before the next prompt", async () => {
    const { host, sessions } = setup();
    await host.start();
    const s = sessions[0];
    const order: string[] = [];
    const prompt = s.prompt.bind(s);
    s.prompt = async (text, options) => {
      order.push(`prompt:${text}`);
      return prompt(text, options);
    };
    const custom = s.sendCustomMessage.bind(s);
    s.sendCustomMessage = async (message, options) => {
      order.push(`context:${String(message.content)}`);
      return custom(message, options);
    };
    await host.handleMessage(msg("m1", "hi"));
    await host.handleMessage(msg("c1", "ctx", { kind: "context" }));
    const settled = gate();
    s.settleGate = settled.promise;
    s.finish("reply");
    const m2 = host.handleMessage(msg("m2", "next"));
    s.settleGate = null;
    settled.open();
    await m2;
    expect(order).toEqual([`prompt:${stamped("m1", "hi")}`, `context:${stamped("c1", "ctx")}`, `prompt:${stamped("m2", "next")}`]);
  });
});

describe("PersonalSession origin echo", () => {
  const WEB = { surface: "web", conversationId: "tab-1" };

  test("a turn's events and its reply carry the prompting message's origin, and a resend keeps it", async () => {
    const { host, sessions, transport, stateDir } = setup();
    await host.start();
    transport.fail = true;
    await host.handleMessage(msg("m1", "hi", { origin: WEB }));
    sessions[0].finish("hello there");
    await tick();

    const events = transport.notifications.map((n) => n.params as ChatEventParams);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.origin).toEqual(WEB);
    expect(transport.delivered()[0]!.origin).toEqual(WEB);

    const restarted = setup({ stateDir });
    restarted.host.resendUnacked();
    expect(restarted.transport.delivered()[0]!.origin).toEqual(WEB);
  });

  test("a steer from another surface joins the run, which still answers on the run's origin", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "hi", { origin: WEB }));
    expect(await host.handleMessage(msg("m2", "also", { origin: DM_ORIGIN }))).toEqual({ accepted: true, mode: "steer" });
    sessions[0].finish("both answered");
    await tick();
    expect(transport.delivered().map((d) => d.origin)).toEqual([WEB]);
  });

  test("the next run answers on its own message's origin", async () => {
    const { host, sessions, transport } = setup();
    await host.start();
    await host.handleMessage(msg("m1", "hi", { origin: WEB }));
    sessions[0].finish("one");
    await tick();
    await host.handleMessage(msg("m2", "again", { origin: DM_ORIGIN }));
    sessions[0].finish("two");
    await tick();
    expect(transport.delivered().map((d) => d.origin)).toEqual([WEB, DM_ORIGIN]);
    const turnStarts = transport.notifications.map((n) => n.params as ChatEventParams).filter((e) => e.ev.type === "turn_start");
    expect(turnStarts.map((e) => e.origin)).toEqual([WEB, DM_ORIGIN]);
  });
});
