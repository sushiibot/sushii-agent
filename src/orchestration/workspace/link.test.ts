import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import type { ToolEntry, ToolHosts } from "../../core/contracts.ts";
import { RPC_METHODS, chatDeliverParams, chatEventParams, chatMessageParams, type ChatDeliverParams, type ChatEventPayload, type ChatOrigin } from "../contracts.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../transport/server.ts";
import { WorkspaceLink, type WorkspaceRpc } from "./link.ts";
import type { Timers } from "./progress.ts";
import { handleOwnerMessage } from "./router.ts";
import {
  SurfaceRegistry,
  SurfaceUnavailableError,
  type AckKind,
  type ApprovalDecision,
  type ApprovalView,
  type AskView,
  type InboundMessage,
  type ProgressFinal,
  type ProgressView,
  type ReplyView,
  type RouterNotice,
  type SendAttempt,
  type SurfaceAdapter,
  type SurfaceCapabilities,
  type SurfaceMessageHandle,
} from "./surface.ts";
import { WorkspaceTools } from "./tools.ts";

const P = "drk";
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "idle" };
const DISCORD: ChatOrigin = { surface: "discord", conversationId: "dm-1" };
const TEST: ChatOrigin = { surface: "test", conversationId: "tab-1" };

type Call = { method: string; origin?: ChatOrigin | null; arg?: unknown };

/** A surface that records the structured calls it gets, so the core's routing and views are visible. */
class FakeAdapter implements SurfaceAdapter {
  calls: Call[] = [];
  unavailable = false;
  private seq = 0;
  readonly capabilities: SurfaceCapabilities;

  constructor(
    readonly surface: string,
    caps: Partial<SurfaceCapabilities> = {},
  ) {
    this.capabilities = { streaming: false, tables: false, richButtons: false, reactions: false, maxMessageChars: 2000, ...caps };
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  private check(): void {
    if (this.unavailable) throw new SurfaceUnavailableError("test surface unreachable");
  }

  async sendReply(origin: ChatOrigin | null, reply: ReplyView, _attempt: SendAttempt): Promise<void> {
    this.check();
    this.calls.push({ method: "sendReply", origin, arg: reply });
  }
  async askPrompt(origin: ChatOrigin | null, ask: AskView, _attempt: SendAttempt): Promise<void> {
    this.calls.push({ method: "askPrompt", origin, arg: ask });
  }
  async progressCreate(origin: ChatOrigin | null, view: ProgressView): Promise<SurfaceMessageHandle> {
    this.calls.push({ method: "progressCreate", origin, arg: structuredClone(view) });
    return { id: `${this.surface}-${++this.seq}` };
  }
  async progressUpdate(handle: SurfaceMessageHandle, view: ProgressView): Promise<void> {
    this.calls.push({ method: "progressUpdate", arg: { id: handle.id, view: structuredClone(view) } });
  }
  async progressFinalize(origin: ChatOrigin | null, handle: SurfaceMessageHandle | null, final: ProgressFinal): Promise<void> {
    this.calls.push({ method: "progressFinalize", origin, arg: { id: handle?.id ?? null, final } });
  }
  async progressReopen(origin: ChatOrigin | null, id: string): Promise<SurfaceMessageHandle | null> {
    this.calls.push({ method: "progressReopen", origin, arg: id });
    return { id };
  }
  async approvalPrompt(origin: ChatOrigin | null, view: ApprovalView, nonce: string): Promise<SurfaceMessageHandle> {
    this.calls.push({ method: "approvalPrompt", origin, arg: { view, nonce } });
    return { id: nonce };
  }
  async resolveApproval(_handle: SurfaceMessageHandle, _view: ApprovalView, _nonce: string, decision: ApprovalDecision): Promise<void> {
    this.calls.push({ method: "resolveApproval", arg: decision });
  }
  async ack(message: InboundMessage, kind: AckKind): Promise<void> {
    this.calls.push({ method: "ack", origin: message.origin, arg: kind });
  }
  async notice(message: InboundMessage, notice: RouterNotice): Promise<void> {
    this.calls.push({ method: "notice", origin: message.origin, arg: notice });
  }
  async transcribe(): Promise<string | null> {
    return null;
  }
  async fallbackReply(message: InboundMessage, text: string, opts: { offline: boolean }): Promise<string | null> {
    this.calls.push({ method: "fallbackReply", origin: message.origin, arg: { text, ...opts } });
    return "fallback reply";
  }
  async resetFallback(): Promise<void> {}
}

class FakeRpc implements WorkspaceRpc {
  connected = true;
  handler: WorkspaceHandler | null = null;
  calls: Array<{ method: string; params: unknown }> = [];
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined {
    return this.connected && principalId === P ? CONN : undefined;
  }
  async requestWorkspace(_p: string, method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return method === RPC_METHODS.chatMessage ? { accepted: true, mode: "prompt" } : {};
  }
  setWorkspaceHandler(handler: WorkspaceHandler | null): void {
    this.handler = handler;
  }
}

const immediate: Timers = { set: (fn) => setTimeout(fn, 0), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const tick = () => new Promise((r) => setTimeout(r, 0));

function newStore(): WorkspaceLinkStore {
  const db = new Database(":memory:");
  applySchema(db);
  return new WorkspaceLinkStore(db);
}

function setup(opts: { streaming?: boolean; store?: WorkspaceLinkStore } = {}) {
  const test = new FakeAdapter("test", { streaming: opts.streaming ?? false });
  const discord = new FakeAdapter("discord");
  const surfaces = new SurfaceRegistry("test").register(test).register(discord);
  const store = opts.store ?? newStore();
  const rpc = new FakeRpc();
  const link = new WorkspaceLink({ principalId: P, store, surfaces, owner: () => ({ id: "owner-1", name: "drk" }), timers: immediate });
  link.attach(rpc);
  const event = (turnId: string, ev: ChatEventPayload, origin?: ChatOrigin) =>
    rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { ...(origin ? { origin } : {}), principalId: P, turnId, agentId: "main", ev });
  return { link, rpc, store, test, discord, event };
}

function deliverParams(overrides: Partial<ChatDeliverParams> = {}): ChatDeliverParams {
  return { outboxId: "o1", principalId: P, kind: "reply", text: "hello", ...overrides };
}

describe("chat protocol origin", () => {
  test("chat/message requires an origin", () => {
    const base = { principalId: P, messageId: "1", text: "hi", kind: "user", author: { id: "1", name: "drk" } };
    expect(chatMessageParams.safeParse(base).success).toBe(false);
    expect(chatMessageParams.safeParse({ ...base, origin: { surface: "discord" } }).success).toBe(false);
    expect(chatMessageParams.safeParse({ ...base, origin: DISCORD }).success).toBe(true);
  });

  test("chat/deliver and chat/event take an optional origin", () => {
    expect(chatDeliverParams.safeParse(deliverParams()).success).toBe(true);
    expect(chatDeliverParams.parse(deliverParams({ origin: TEST })).origin).toEqual(TEST);
    const ev = { principalId: P, turnId: "t", agentId: "main", ev: { type: "turn_start" } };
    expect(chatEventParams.safeParse(ev).success).toBe(true);
    expect(chatEventParams.parse({ ...ev, origin: DISCORD }).origin).toEqual(DISCORD);
  });
});

describe("surface routing", () => {
  test("a delivery goes to its origin's surface", async () => {
    const { link, test, discord } = setup();
    await link.deliver(deliverParams({ origin: DISCORD }));
    expect(discord.of("sendReply")).toEqual([{ method: "sendReply", origin: DISCORD, arg: { kind: "reply", text: "hello", toolCount: null } }]);
    expect(test.calls).toEqual([]);
  });

  test("a proactive delivery without an origin goes to the preferred surface's default conversation", async () => {
    const { link, test, discord } = setup();
    await link.deliver(deliverParams({ kind: "proactive", text: "reminder" }));
    expect(test.of("sendReply")).toEqual([{ method: "sendReply", origin: null, arg: { kind: "proactive", text: "reminder", toolCount: null } }]);
    expect(discord.calls).toEqual([]);
  });

  test("an origin on an unregistered surface falls back to the preferred surface, and is acked", async () => {
    const { link, rpc, test } = setup();
    await link.deliver(deliverParams({ origin: { surface: "slack", conversationId: "C1" } }));
    expect(test.of("sendReply").map((c) => c.origin)).toEqual([null]);
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck]);
  });

  test("an unreachable surface leaves the delivery unacked without counting a render failure", async () => {
    const { link, rpc, store, test } = setup();
    test.unavailable = true;
    await link.deliver(deliverParams({ origin: TEST }));
    expect(rpc.calls).toEqual([]);
    expect(store.getKv("workspace:deliver_failures:o1")).toBeNull();
    expect(store.hasSeenOutbox("o1")).toBe(false);
  });

  test("an ask reaches the surface as a structured view with labelled choices", async () => {
    const { link, discord } = setup();
    await link.deliver(deliverParams({ origin: DISCORD, kind: "ask", ask: { askId: "a1", question: "Merge?", choices: ["Yes", " "] } }));
    expect(discord.of("askPrompt")[0]!.arg).toEqual({ askId: "a1", question: "Merge?", choices: ["Yes", "(option 2)"] });
    expect(link.askChoice("a1", 1, null)).toBe("(option 2)");
  });

  test("a turn's progress view lives on the surface its events name, from first tool to the reply", async () => {
    const { link, test, discord, event } = setup();
    event("t1", { type: "turn_start" }, DISCORD);
    event("t1", { type: "tool_start", name: "bash", summary: "ls" }, DISCORD);
    await tick();
    expect(discord.of("progressCreate")).toHaveLength(1);
    expect(discord.of("progressCreate")[0]!.origin).toEqual(DISCORD);
    await link.deliver(deliverParams({ origin: DISCORD, turnId: "t1" }));
    await link.settled();
    await tick();
    const final = discord.of("progressFinalize")[0]!.arg as { id: string; final: ProgressFinal };
    expect(final.id).toBe("discord-1");
    expect(final.final.outcome).toBe("done");
    expect(final.final.summary?.toolCount).toBe(1);
    expect((discord.of("sendReply")[0]!.arg as ReplyView).toolCount).toBe(1);
    expect(test.calls).toEqual([]);
  });

  test("a stopped tool-less turn posts its final state on the origin surface", async () => {
    const { test, discord, event } = setup();
    event("t2", { type: "turn_end", aborted: true }, TEST);
    await tick();
    expect(test.of("progressFinalize")).toEqual([{ method: "progressFinalize", origin: TEST, arg: { id: null, final: { outcome: "stopped", summary: { durationMs: 0, toolCount: 0 } } } }]);
    expect(discord.calls).toEqual([]);
  });
});

describe("capabilities", () => {
  test("a streaming surface gets the turn's text as it arrives", async () => {
    const { test, event } = setup({ streaming: true });
    event("t1", { type: "turn_start" }, TEST);
    event("t1", { type: "text_delta", text: "Hel" }, TEST);
    await tick();
    event("t1", { type: "text_delta", text: "lo" }, TEST);
    await tick();
    await tick();
    expect((test.of("progressCreate")[0]!.arg as ProgressView).text).toBe("Hel");
    const updates = test.of("progressUpdate").map((c) => (c.arg as { view: ProgressView }).view.text);
    expect(updates.at(-1)).toBe("Hello");
  });

  test("a surface without streaming never hears about text deltas", async () => {
    const { link, discord, event } = setup({ streaming: true });
    event("t1", { type: "turn_start" }, DISCORD);
    event("t1", { type: "text_delta", text: "Hello" }, DISCORD);
    await tick();
    expect(discord.calls).toEqual([]);
    expect(link.hasTurn("t1")).toBe(true);
    event("t9", { type: "text_delta", text: "stray" }, DISCORD);
    expect(link.hasTurn("t9")).toBe(false);
  });
});

describe("restart state", () => {
  test("a progress view persisted without an origin is restored on the preferred surface", async () => {
    const store = newStore();
    store.setKv(`workspace:progress:${P}`, JSON.stringify({ open: [{ turnId: "old", messageId: "m-1", startedAt: 1, toolCount: 2, lines: [] }], ended: [] }));
    const { rpc, test, discord } = setup({ store });
    rpc.handler!.onRegister!(CONN);
    await tick();
    await tick();
    expect(test.of("progressReopen")).toEqual([{ method: "progressReopen", origin: null, arg: "m-1" }]);
    expect((test.of("progressFinalize")[0]!.arg as { final: ProgressFinal }).final.outcome).toBe("interrupted");
    expect(discord.calls).toEqual([]);
  });

  test("a persisted view keeps its origin across a restart", async () => {
    const store = newStore();
    const first = setup({ store });
    first.event("t1", { type: "turn_start" }, DISCORD);
    first.event("t1", { type: "tool_start", name: "bash", summary: "" }, DISCORD);
    await tick();
    await tick();
    const second = setup({ store });
    second.rpc.handler!.onRegister!(CONN);
    await tick();
    expect(second.discord.of("progressReopen")).toEqual([{ method: "progressReopen", origin: DISCORD, arg: "discord-1" }]);
  });

  test("offline exchanges replay with their stored origin; rows without one use the preferred surface", async () => {
    const store = newStore();
    store.addInbox(P, "legacy q", "legacy a", 1);
    const { link, rpc } = setup({ store });
    rpc.connected = false;
    link.recordOffline("q", "a", DISCORD);
    rpc.connected = true;
    await link.replayInbox();
    const origins = rpc.calls.filter((c) => c.method === RPC_METHODS.chatMessage).map((c) => (c.params as { origin: ChatOrigin }).origin);
    expect(origins).toEqual([{ surface: "test", conversationId: "" }, DISCORD]);
  });
});

describe("owner router on a second surface", () => {
  const message = (text: string): InboundMessage => ({ origin: TEST, id: "m1", text, author: { id: "owner-1", name: "drk" }, isVoice: false, attachments: [] });

  test("a connected message carries its origin and gets a structured ack", async () => {
    const { link, rpc, test } = setup();
    const advanced: string[] = [];
    await handleOwnerMessage(message("hi"), { workspaceEnabled: true, transcriptionEnabled: false, link, surface: test, cursor: { advance: (id) => void advanced.push(id) } });
    expect((rpc.calls[0]!.params as { origin: ChatOrigin }).origin).toEqual(TEST);
    expect(test.of("ack")).toEqual([{ method: "ack", origin: TEST, arg: "accepted" }]);
    expect(advanced).toEqual(["m1"]);
  });

  test("offline: the fallback answers with the offline flag, and the exchange is recorded with its origin", async () => {
    const { link, rpc, store, test } = setup();
    rpc.connected = false;
    await handleOwnerMessage(message("hi"), { workspaceEnabled: true, transcriptionEnabled: false, link, surface: test, cursor: { advance: () => {} } });
    expect(test.of("fallbackReply")).toEqual([{ method: "fallbackReply", origin: TEST, arg: { text: "hi", offline: true } }]);
    expect(store.listInbox(P).map((r) => r.origin)).toEqual([TEST]);
  });

  test("!new while offline is a notice, not a reset", async () => {
    const { link, rpc, test } = setup();
    rpc.connected = false;
    await handleOwnerMessage(message("!new"), { workspaceEnabled: true, transcriptionEnabled: false, link, surface: test, cursor: { advance: () => {} } });
    expect(test.of("notice").map((c) => c.arg)).toEqual([{ type: "newWhileOffline" }]);
  });
});

describe("tool approvals", () => {
  test("an approval prompt goes to the preferred surface as structured fields", async () => {
    const test = new FakeAdapter("test");
    const surfaces = new SurfaceRegistry("test").register(test).register(new FakeAdapter("discord"));
    const entry: ToolEntry<keyof ToolHosts> = {
      name: "file_linear_issue",
      definition: {
        name: "file_linear_issue",
        description: "file",
        parameters: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, repo_label: { type: "string" } } },
      },
      requiresHosts: [],
      execute: async () => ({ content: "filed" }),
    };
    const tools = new WorkspaceTools({
      principalId: P,
      ownerUserId: () => "owner-1",
      toolSpace: { surface: "test", spaceId: "private" },
      surfaces,
      store: {} as never,
      memory: { count: () => 0, getServerContext: () => null } as never,
      registry: { resolve: () => [entry] },
      log: { info: () => {} },
    });
    const pending = tools.handleCall(CONN, { principalId: P, callId: "c1", name: "file_linear_issue", args: { title: "T", description: "D", repo_label: "r" }, agentId: "main", agentName: "main" });
    for (let i = 0; i < 20 && !test.of("approvalPrompt").length; i++) await tick();
    const { view, nonce } = test.of("approvalPrompt")[0]!.arg as { view: ApprovalView; nonce: string };
    expect(test.of("approvalPrompt")[0]!.origin).toBeNull();
    expect(view.fields.map((f) => [f.key, f.value, f.kind])).toEqual([
      ["repo_label", "r", "single"],
      ["title", "T", "single"],
      ["description", "D", "body"],
    ]);
    expect(tools.decide(nonce, "approve")).toBe(true);
    expect(await pending).toEqual({ ok: true, result: "filed" });
    expect(test.of("resolveApproval").map((c) => c.arg)).toEqual(["approve", "approve"]);
  });
});
