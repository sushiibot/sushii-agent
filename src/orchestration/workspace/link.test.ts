import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import type { ToolEntry, ToolHosts } from "../../core/contracts.ts";
import { AUTH_METHODS, LOGIN_ALREADY_PENDING, RPC_METHODS, chatDeliverParams, chatEventParams, chatMessageParams, type ChatDeliverParams, type ChatEventPayload, type ChatMessageParams, type ChatOrigin } from "../contracts.ts";
import { RpcTimeoutError, type ConnectionInfo, type WorkspaceHandler } from "../transport/server.ts";
import { LOGIN_PENDING_MS, MAX_OPEN_TURNS, WorkspaceLink, type WorkspaceRpc } from "./link.ts";
import type { Timers } from "./progress.ts";
import { detectLoginCallback, handleOwnerMessage } from "./router.ts";
import {
  DeliveryRejectedError,
  SurfaceRegistry,
  SurfaceUnavailableError,
  type AckKind,
  type ApprovalDecision,
  type ApprovalView,
  type AskView,
  type AuthPromptView,
  type InboundMessage,
  type ProgressFinal,
  type ProgressView,
  type ReplyView,
  type RouterNotice,
  type SendAttempt,
  type SurfaceActor,
  type SurfaceAdapter,
  type SurfaceCapabilities,
  type SurfaceMessageHandle,
} from "./surface.ts";
import { APPROVAL_TIMEOUT_MS, WorkspaceTools } from "./tools.ts";

const P = "drk";
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "idle" };
const DISCORD: ChatOrigin = { surface: "discord", conversationId: "dm-1" };
const TEST: ChatOrigin = { surface: "test", conversationId: "tab-1" };

type Call = { method: string; origin?: ChatOrigin | null; arg?: unknown };

/** A surface that records the structured calls it gets, so the core's routing and views are visible. */
class FakeAdapter implements SurfaceAdapter {
  calls: Call[] = [];
  unavailable = false;
  /** Every send refuses the delivery for good. */
  rejects = false;
  /** The adapter's progress edit gap, whatever the turn's age. */
  gap = 0;
  /** Holds approvalPrompt's post until opened. */
  promptGate: Promise<void> | null = null;
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
    if (this.rejects) throw new DeliveryRejectedError("not for this surface");
  }

  async sendReply(origin: ChatOrigin | null, reply: ReplyView, _attempt: SendAttempt): Promise<void> {
    this.check();
    this.calls.push({ method: "sendReply", origin, arg: reply });
  }
  async askPrompt(origin: ChatOrigin | null, ask: AskView, _attempt: SendAttempt): Promise<void> {
    this.calls.push({ method: "askPrompt", origin, arg: ask });
  }
  async authPrompt(origin: ChatOrigin | null, view: AuthPromptView, _attempt: SendAttempt): Promise<void> {
    this.check();
    this.calls.push({ method: "authPrompt", origin, arg: view });
  }
  progressEditGap(): number {
    return this.gap;
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
    if (this.promptGate) await this.promptGate;
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

  test("a stopped tool-less turn posts its final state, with its turnId, on the origin surface", async () => {
    const { test, discord, event } = setup();
    event("t2", { type: "turn_start" }, TEST);
    event("t2", { type: "turn_end", aborted: true }, TEST);
    await tick();
    expect(test.of("progressFinalize")).toEqual([
      { method: "progressFinalize", origin: TEST, arg: { id: null, final: { outcome: "stopped", summary: { durationMs: 0, toolCount: 0 }, turnId: "t2" } } },
    ]);
    expect(discord.calls).toEqual([]);
  });

  test("a surface with turnStarted opens the view at turn_start, and later edits and the final use that view", async () => {
    const { link, test, event } = setup({ streaming: true });
    const started: string[] = [];
    Object.assign(test, {
      turnStarted: async (origin: ChatOrigin | null, view: ProgressView) => {
        started.push(view.turnId);
        test.calls.push({ method: "turnStarted", origin, arg: structuredClone(view) });
        return { id: `started-${view.turnId}` };
      },
    });
    event("t1", { type: "turn_start" }, TEST);
    await tick();
    expect(started).toEqual(["t1"]);
    expect(test.of("progressCreate")).toEqual([]);
    event("t1", { type: "tool_start", name: "bash", summary: "ls" }, TEST);
    event("t1", { type: "turn_end", aborted: false }, TEST);
    await link.settled();
    await tick();
    expect(test.of("progressCreate")).toEqual([]);
    expect((test.of("progressFinalize")[0]!.arg as { id: string }).id).toBe("started-t1");
  });

  test("a turn_start closes any other open main turn, whose turn_end was lost", async () => {
    const { link, test, event } = setup();
    event("t1", { type: "turn_start" }, TEST);
    event("t1", { type: "tool_start", name: "bash", summary: "ls" }, TEST);
    await tick();
    event("t2", { type: "turn_start" }, TEST);
    await link.settled();
    await tick();
    expect(test.of("progressFinalize").map((c) => (c.arg as { id: string; final: ProgressFinal }).final.outcome)).toEqual(["done"]);
  });

  test("a turn_end for a turn never seen to start is ignored, however often it repeats", async () => {
    const { test, event } = setup();
    for (let i = 0; i < 50; i++) event("ghost", { type: "turn_end", aborted: true }, TEST);
    await tick();
    expect(test.calls).toEqual([]);
  });

  test("chat/event refuses an empty or oversized turnId", async () => {
    const { test, event } = setup({ streaming: true });
    event("", { type: "tool_start", name: "t", summary: "s" }, TEST);
    event("x".repeat(257), { type: "tool_start", name: "t", summary: "s" }, TEST);
    await tick();
    expect(test.calls).toEqual([]);
  });

  test("past MAX_OPEN_TURNS the oldest open turn is finalized as interrupted", async () => {
    const { test, event } = setup();
    for (let i = 0; i <= MAX_OPEN_TURNS; i++) event(`t${i}`, { type: "tool_start", name: "t", summary: "s" }, TEST);
    await tick();
    await tick();
    const finals = test.of("progressFinalize").map((c) => (c.arg as { id: string | null; final: ProgressFinal }).final.outcome);
    expect(finals).toEqual(["interrupted"]);
    expect(test.of("progressCreate")).toHaveLength(MAX_OPEN_TURNS + 1);
  });

  test("a delivery the surface refuses for good is acked once and not resent", async () => {
    const { link, rpc, store, test } = setup();
    test.rejects = true;
    await link.deliver(deliverParams());
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck]);
    expect(store.hasSeenOutbox("o1")).toBe(true);
    await link.deliver(deliverParams());
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck, RPC_METHODS.chatAck]);
  });
});

describe("capabilities", () => {
  test("chat/message says the origin surface can take file uploads only when its adapter can", async () => {
    const { link, rpc, discord } = setup();
    discord.capabilities.fileUploads = true;
    const author = { id: "1", name: "drk" };
    await link.sendMessage({ origin: DISCORD, messageId: "m1", text: "hi", kind: "user", author });
    await link.sendMessage({ origin: TEST, messageId: "m2", text: "hi", kind: "user", author });
    const sent = rpc.calls.filter((c) => c.method === RPC_METHODS.chatMessage).map((c) => (c.params as ChatMessageParams).fileUploads);
    expect(sent).toEqual([true, undefined]);
  });

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
    expect(tools.decide(nonce, "approve", { surface: "test", userId: "owner-1", name: "drk" })).toBe("decided");
    expect(await pending).toEqual({ ok: true, result: "filed" });
    expect(test.of("resolveApproval").map((c) => c.arg)).toEqual(["approve", "approve"]);
  });
});

const OWNER_TEST: SurfaceActor = { surface: "test", userId: "owner-1", name: "drk" };
const OWNER_DISCORD: SurfaceActor = { surface: "discord", userId: "owner-1", name: "drk" };

/** Timers that record each requested delay and fire only when told to. */
class ManualTimers implements Timers {
  handles = new Map<number, { fn: () => void; ms: number }>();
  private seq = 0;
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.handles.set(id, { fn, ms });
    return id;
  }
  clear(h: unknown): void {
    this.handles.delete(h as number);
  }
  fire(ms: number): void {
    for (const [id, h] of [...this.handles]) {
      if (h.ms !== ms) continue;
      this.handles.delete(id);
      h.fn();
    }
  }
}

const LINEAR: ToolEntry<keyof ToolHosts> = {
  name: "file_linear_issue",
  definition: {
    name: "file_linear_issue",
    description: "file",
    parameters: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, repo_label: { type: "string" } } },
  },
  requiresHosts: [],
  execute: async () => ({ content: "filed" }),
};

/** A buttonless preferred surface ("test") next to a surface with buttons ("discord"), one link and its tools. */
function approvalSetup(opts: { timers?: Timers; executed?: string[] } = {}) {
  const test = new FakeAdapter("test");
  const discord = new FakeAdapter("discord", { richButtons: true });
  const surfaces = new SurfaceRegistry("test").register(test).register(discord);
  const entry: ToolEntry<keyof ToolHosts> = {
    ...LINEAR,
    execute: async (input) => {
      opts.executed?.push(String((input as { title?: string }).title));
      return { content: "filed" };
    },
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
    ...(opts.timers ? { timers: opts.timers } : {}),
  });
  const rpc = new FakeRpc();
  const link = new WorkspaceLink({ principalId: P, store: newStore(), surfaces, owner: () => ({ id: "owner-1", name: "drk" }), timers: immediate, tools });
  link.attach(rpc);
  const call = (callId: string, title = "T") =>
    tools.handleCall(CONN, { principalId: P, callId, name: "file_linear_issue", args: { title, description: "D", repo_label: "r" }, agentId: "main", agentName: "main" });
  const prompted = async (n = 1) => {
    for (let i = 0; i < 50 && test.of("approvalPrompt").length < n; i++) await tick();
    return test.of("approvalPrompt")[n - 1]!.arg as { view: ApprovalView; nonce: string };
  };
  const from = (origin: ChatOrigin, text: string, authorId = "owner-1"): InboundMessage => ({ origin, id: `m-${text}`, text, author: { id: authorId, name: "drk" }, isVoice: false, attachments: [] });
  const route = (message: InboundMessage) =>
    handleOwnerMessage(message, { workspaceEnabled: true, transcriptionEnabled: false, link, surface: surfaces.get(message.origin.surface)!, cursor: { advance: () => {} } });
  const chatMessages = () => rpc.calls.filter((c) => c.method === RPC_METHODS.chatMessage).map((c) => c.params as { messageId: string; text: string; origin: ChatOrigin });
  return { test, discord, tools, rpc, link, call, prompted, from, route, chatMessages };
}

describe("text approvals on a surface without buttons", () => {
  test("end to end: the prompt carries a code, `approve <code>` runs the tool, and the reply never reaches the workspace", async () => {
    const executed: string[] = [];
    const h = approvalSetup({ executed });
    const pending = h.call("c1");
    const { view } = await h.prompted();
    expect(view.replyCode).toMatch(/^[a-z2-9]{6}$/);
    await h.route(h.from(TEST, `approve ${view.replyCode}`));
    expect(await pending).toEqual({ ok: true, result: "filed" });
    expect(executed).toEqual(["T"]);
    expect(h.test.of("resolveApproval").map((c) => c.arg)).toEqual(["approve", "approve"]);
    expect(h.test.of("ack").map((c) => c.arg)).toEqual(["accepted"]);
    expect(h.chatMessages()).toEqual([]);
    expect(h.test.of("fallbackReply")).toEqual([]);
  });

  test("a code is single-use, case-insensitive, and `deny` denies", async () => {
    const h = approvalSetup();
    const pending = h.call("c1");
    const { view } = await h.prompted();
    await h.route(h.from(TEST, `  DENY ${view.replyCode!.toUpperCase()} `));
    expect(await pending).toMatchObject({ ok: false, denied: true });
    await h.route(h.from(TEST, `approve ${view.replyCode}`));
    expect(h.test.of("notice").map((c) => c.arg)).toEqual([{ type: "approvalExpired" }]);
    expect(h.chatMessages()).toEqual([]);
  });

  test("a wrong code, a stranger, or a code typed on another surface decides nothing", async () => {
    const executed: string[] = [];
    const h = approvalSetup({ executed });
    const pending = h.call("c1");
    const { view, nonce } = await h.prompted();
    await h.route(h.from(TEST, "approve zzzzzz"));
    await h.route(h.from(TEST, `approve ${view.replyCode}`, "stranger"));
    expect(h.test.of("notice").map((c) => c.arg)).toEqual([{ type: "approvalExpired" }, { type: "approvalExpired" }]);
    expect(h.tools.decideByCode(view.replyCode!, "approve", OWNER_DISCORD)).toBe(false);
    // On a surface with buttons the same text is an ordinary message for the agent.
    await h.route(h.from(DISCORD, `approve ${view.replyCode}`));
    expect(h.chatMessages().map((m) => [m.origin, m.text])).toEqual([[DISCORD, `approve ${view.replyCode}`]]);
    expect(executed).toEqual([]);
    expect(h.tools.decide(nonce, "deny", OWNER_TEST)).toBe("decided");
    expect(await pending).toMatchObject({ denied: true });
  });

  test("the code dies with the approval's timeout", async () => {
    const timers = new ManualTimers();
    const h = approvalSetup({ timers });
    const pending = h.call("c1");
    const { view } = await h.prompted();
    timers.fire(APPROVAL_TIMEOUT_MS);
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("approval timed out") });
    await h.route(h.from(TEST, `approve ${view.replyCode}`));
    expect(h.test.of("notice").map((c) => c.arg)).toEqual([{ type: "approvalExpired" }]);
    expect(h.chatMessages()).toEqual([]);
  });

  test("a surface with buttons gets no code", async () => {
    const test = new FakeAdapter("test", { richButtons: true });
    const tools = new WorkspaceTools({
      principalId: P,
      ownerUserId: () => "owner-1",
      toolSpace: { surface: "test", spaceId: "private" },
      surfaces: new SurfaceRegistry("test").register(test),
      store: {} as never,
      memory: { count: () => 0, getServerContext: () => null } as never,
      registry: { resolve: () => [LINEAR] },
      log: { info: () => {} },
    });
    const pending = tools.handleCall(CONN, { principalId: P, callId: "c1", name: "file_linear_issue", args: { title: "T" }, agentId: "main", agentName: "main" });
    for (let i = 0; i < 50 && !test.of("approvalPrompt").length; i++) await tick();
    const { view, nonce } = test.of("approvalPrompt")[0]!.arg as { view: ApprovalView; nonce: string };
    expect("replyCode" in view).toBe(false);
    tools.decide(nonce, "deny", OWNER_TEST);
    await pending;
  });

  test("the body reaches the adapter whole; clipping is the surface's call", async () => {
    const h = approvalSetup();
    const description = "d".repeat(10_000);
    const pending = h.tools.handleCall(CONN, { principalId: P, callId: "c1", name: "file_linear_issue", args: { title: "T", description }, agentId: "main", agentName: "main" });
    const { view, nonce } = await h.prompted();
    expect(view.fields.find((f) => f.key === "description")).toEqual({ key: "description", kind: "body", value: description });
    h.tools.decide(nonce, "deny", OWNER_TEST);
    await pending;
  });
});

describe("approval races", () => {
  test("a click that lands while the prompt is still posting counts", async () => {
    const executed: string[] = [];
    const h = approvalSetup({ executed });
    let open!: () => void;
    h.test.promptGate = new Promise((r) => (open = r));
    const pending = h.call("c1");
    const { nonce } = await h.prompted();
    expect(h.tools.decide(nonce, "approve", OWNER_TEST)).toBe("decided");
    open();
    expect(await pending).toEqual({ ok: true, result: "filed" });
    expect(h.test.of("resolveApproval").map((c) => c.arg)).toEqual(["approve", "approve"]);
  });

  test("the socket closing while the prompt is still posting expires it, and the prompt then shows expired", async () => {
    const executed: string[] = [];
    const h = approvalSetup({ executed });
    let open!: () => void;
    h.test.promptGate = new Promise((r) => (open = r));
    const pending = h.call("c1");
    const { nonce, view } = await h.prompted();
    h.tools.onSocketClosed(CONN);
    open();
    expect(await pending).toMatchObject({ ok: false, denied: true });
    expect(h.test.of("resolveApproval").map((c) => c.arg)).toEqual(["expired"]);
    expect(h.tools.decide(nonce, "approve", OWNER_TEST)).toBe("expired");
    expect(h.tools.decideByCode(view.replyCode!, "approve", OWNER_TEST)).toBe(false);
    expect(executed).toEqual([]);
  });
});

describe("tool/cancel through the link", () => {
  test("a cancel routed from the workspace retires the prompt's reply code", async () => {
    const executed: string[] = [];
    const h = approvalSetup({ executed });
    const pending = h.call("c1");
    const { view } = await h.prompted();
    expect(await h.rpc.handler!.onRequest!(CONN, RPC_METHODS.toolCancel, { principalId: P, callId: "c1" })).toEqual({ cancelled: true });
    expect(await pending).toEqual({ ok: false, error: "cancelled" });
    expect(h.test.of("resolveApproval").map((c) => c.arg)).toEqual(["cancelled"]);
    await h.route(h.from(TEST, `approve ${view.replyCode}`));
    expect(h.test.of("notice").map((c) => c.arg)).toEqual([{ type: "approvalExpired" }]);
    expect(executed).toEqual([]);
  });
});

describe("asks answered through the core", () => {
  test("on a surface without buttons, a choice's number answers the latest ask, keyed like a button click", async () => {
    const h = approvalSetup();
    await h.link.deliver(deliverParams({ origin: TEST, kind: "ask", ask: { askId: "a1", question: "Merge?", choices: ["Yes", "No"] } }));
    await h.route(h.from(TEST, "2"));
    expect(h.chatMessages()).toEqual([expect.objectContaining({ messageId: "wsask:a1", text: "No", origin: TEST })]);
    expect(h.test.of("ack").map((c) => c.arg)).toEqual(["accepted"]);
    // Answered: the next number is an ordinary message again.
    await h.route(h.from(TEST, "2"));
    expect(h.chatMessages().map((m) => m.messageId)).toEqual(["wsask:a1", "m-2"]);
  });

  test("a number out of range, or on a surface with buttons, is an ordinary message", async () => {
    const h = approvalSetup();
    await h.link.deliver(deliverParams({ origin: TEST, kind: "ask", ask: { askId: "a1", question: "Merge?", choices: ["Yes", "No"] } }));
    await h.link.deliver(deliverParams({ outboxId: "o2", origin: DISCORD, kind: "ask", ask: { askId: "a2", question: "Ship?", choices: ["Yes"] } }));
    await h.route(h.from(TEST, "3"));
    await h.route(h.from(DISCORD, "1"));
    expect(h.chatMessages().map((m) => [m.messageId, m.text])).toEqual([
      ["m-3", "3"],
      ["m-1", "1"],
    ]);
  });

  test("the same ask answered from two surfaces uses one message id, so the workspace sees a duplicate", async () => {
    const h = approvalSetup();
    await h.link.deliver(deliverParams({ origin: TEST, kind: "ask", ask: { askId: "a1", question: "Merge?", choices: ["Yes", "No"] } }));
    const a = await h.link.answerAsk(DISCORD, "a1", { index: 0 }, OWNER_DISCORD);
    const b = await h.link.answerAsk(TEST, "a1", { text: "No" }, OWNER_TEST);
    expect([a.status, b.status]).toEqual(["answered", "answered"]);
    expect(h.chatMessages().map((m) => m.messageId)).toEqual(["wsask:a1", "wsask:a1"]);
  });

  test("a stranger's answer is refused before anything is deferred or sent", async () => {
    const h = approvalSetup();
    await h.link.deliver(deliverParams({ origin: TEST, kind: "ask", ask: { askId: "a1", question: "Merge?", choices: ["Yes"] } }));
    let accepted = false;
    const res = await h.link.answerAsk(TEST, "a1", { index: 0 }, { ...OWNER_TEST, userId: "stranger" }, { onAccepted: async () => void (accepted = true) });
    expect(res).toEqual({ status: "forbidden" });
    expect(accepted).toBe(false);
    expect(await h.link.answerAsk(TEST, "a9", { index: 0 }, OWNER_TEST)).toEqual({ status: "inactive" });
    expect(h.chatMessages()).toEqual([]);
  });
});

describe("stop through the core", () => {
  test("a tracked turn is aborted and left to the event stream; an untracked one comes back with its final state", async () => {
    const { link, rpc, event } = setup();
    rpc.requestWorkspace = async (_p, method, params) => {
      rpc.calls.push({ method, params });
      return { aborted: true };
    };
    event("t1", { type: "turn_start" }, TEST);
    const order: string[] = [];
    const tracked = await link.stopTurn(TEST, "t1", OWNER_TEST, { onAccepted: async () => void order.push("accepted") });
    expect(tracked).toEqual({ status: "ok", aborted: true, final: null });
    expect(order).toEqual(["accepted"]);
    expect(await link.stopTurn(TEST, "gone", OWNER_TEST)).toEqual({ status: "ok", aborted: true, final: { outcome: "stopped", summary: null } });
    expect(rpc.calls.map((c) => c.params)).toEqual([
      { principalId: P, turnId: "t1" },
      { principalId: P, turnId: "gone" },
    ]);
  });

  test("a stranger can't stop a turn", async () => {
    const { link, rpc } = setup();
    expect(await link.stopTurn(TEST, "t1", { ...OWNER_TEST, userId: "someone" })).toEqual({ status: "forbidden" });
    expect(rpc.calls).toEqual([]);
  });
});

describe("progress cadence comes from the adapter", () => {
  test("an adapter's gap sets the delay between updates; a zero gap updates on every change", async () => {
    const timers = new ManualTimers();
    const slow = new FakeAdapter("test");
    slow.gap = 5_000;
    const link = new WorkspaceLink({ principalId: P, store: newStore(), surfaces: new SurfaceRegistry("test").register(slow), owner: () => ({ id: "owner-1", name: "drk" }), timers, now: () => 1_000 });
    const tool = (turnId: string, name: string) => link.onEvent({ origin: TEST, principalId: P, turnId, agentId: "main", ev: { type: "tool_start", name, summary: "" } });
    tool("t1", "a");
    tool("t1", "b");
    expect([...timers.handles.values()].map((h) => h.ms)).toEqual([5_000]);

    const fast = new FakeAdapter("test");
    const link2 = new WorkspaceLink({ principalId: P, store: newStore(), surfaces: new SurfaceRegistry("test").register(fast), owner: () => ({ id: "owner-1", name: "drk" }), timers: new ManualTimers(), now: () => 1_000 });
    for (const name of ["a", "b", "c"]) link2.onEvent({ origin: TEST, principalId: P, turnId: "t1", agentId: "main", ev: { type: "tool_start", name, summary: "" } });
    await link2.settled();
    expect(fast.of("progressUpdate").map((c) => (c.arg as { view: ProgressView }).view.lines.length)).toEqual([3, 3]);
  });

  test("a streaming adapter with progressDelta gets every delta at once, however slow its update gap", async () => {
    class DeltaAdapter extends FakeAdapter {
      deltas: string[] = [];
      async progressDelta(_handle: SurfaceMessageHandle, delta: string): Promise<void> {
        this.deltas.push(delta);
      }
    }
    const web = new DeltaAdapter("test", { streaming: true });
    web.gap = 60_000;
    const timers = new ManualTimers();
    const link = new WorkspaceLink({ principalId: P, store: newStore(), surfaces: new SurfaceRegistry("test").register(web), owner: () => ({ id: "owner-1", name: "drk" }), timers, now: () => 1_000 });
    const delta = (text: string) => link.onEvent({ origin: TEST, principalId: P, turnId: "t1", agentId: "main", ev: { type: "text_delta", text } });
    delta("Hel");
    delta("lo");
    delta(" there");
    await link.settled();
    expect((web.of("progressCreate")[0]!.arg as ProgressView).text).toBe("Hel");
    expect(web.deltas).toEqual(["lo", " there"]);
    expect(web.of("progressUpdate")).toEqual([]);
    expect(timers.handles.size).toBe(0);
  });
});

describe("preferred surface", () => {
  test("is matched case-insensitively and must have an adapter", () => {
    const registry = new SurfaceRegistry(" Discord ").register(new FakeAdapter("discord"));
    expect(registry.preferredSurface).toBe("discord");
    expect(registry.hasPreferred()).toBe(true);
    const typo = new SurfaceRegistry("discrod").register(new FakeAdapter("discord"));
    expect(typo.hasPreferred()).toBe(false);
    expect(typo.registered()).toEqual(["discord"]);
  });
});

describe("ChatGPT login from the surface", () => {
  const CODE = "SECRET-CODE";
  const PASTE = `http://127.0.0.1:1455/auth/callback?code=${CODE}&state=s1&client_id=c1`;

  class AuthRpc extends FakeRpc {
    replies: Record<string, (params: unknown) => unknown> = {
      [AUTH_METHODS.start]: () => ({ started: true, loginId: "L1" }),
      [AUTH_METHODS.complete]: () => ({ ok: true, model: "gpt-6.1-sol" }),
      [AUTH_METHODS.cancel]: () => ({ cancelled: true }),
    };
    override async requestWorkspace(p: string, method: string, params: unknown): Promise<unknown> {
      const reply = this.replies[method];
      if (!reply) return super.requestWorkspace(p, method, params);
      this.calls.push({ method, params });
      return reply(params);
    }
  }

  function setupLogin(opts: { workspaceEnabled?: boolean; isOwner?: boolean } = {}) {
    const discord = new FakeAdapter("discord", { richButtons: true });
    const surfaces = new SurfaceRegistry("discord").register(discord);
    const store = newStore();
    const rpc = new AuthRpc();
    let now = 1_000_000;
    const logs: Array<{ obj: object; msg: string }> = [];
    const link = new WorkspaceLink({
      principalId: P,
      store,
      surfaces,
      owner: () => ({ id: "owner-1", name: "drk" }),
      timers: immediate,
      now: () => now,
      isOwner: () => opts.isOwner ?? true,
      authLog: { info: (obj, msg) => logs.push({ obj, msg }), warn: (obj, msg) => logs.push({ obj, msg }) },
    });
    link.attach(rpc);
    let seq = 0;
    const send = (text: string) =>
      handleOwnerMessage(
        { origin: DISCORD, id: `m${++seq}`, text, author: { id: "owner-1", name: "drk" }, isVoice: false, attachments: [] },
        { workspaceEnabled: opts.workspaceEnabled ?? true, transcriptionEnabled: false, link, surface: discord, cursor: { advance: () => {} } },
      );
    const methods = () => rpc.calls.map((c) => c.method);
    const deliver = (p: Partial<ChatDeliverParams>) => rpc.handler!.onRequest!(CONN, RPC_METHODS.chatDeliver, deliverParams(p));
    return { link, rpc, store, discord, send, methods, logs, deliver, advance: (ms: number) => (now += ms) };
  }

  test("!login chatgpt starts a login from the message's origin", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    expect(t.rpc.calls).toEqual([{ method: AUTH_METHODS.start, params: { principalId: P, provider: "openai", origin: DISCORD } }]);
    expect(t.discord.of("ack").map((c) => c.arg)).toEqual(["accepted"]);
    expect(t.link.isLoginPending()).toBe(true);
  });

  test("the pasted callback goes only to auth/complete: never chat/message, the inbox, the fallback or a log", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    await t.send(`  ${PASTE}  `);
    expect(t.methods()).toEqual([AUTH_METHODS.start, AUTH_METHODS.complete]);
    expect(t.rpc.calls[1]!.params).toEqual({ principalId: P, input: PASTE });
    expect(t.store.listInbox(P)).toEqual([]);
    expect(t.discord.of("fallbackReply")).toEqual([]);
    expect(t.discord.of("notice")).toEqual([]);
    expect(t.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.logs)).not.toContain(CODE);
    expect(t.link.isLoginPending()).toBe(false);
  });

  test("the localhost spelling is intercepted too", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    await t.send(PASTE.replace("127.0.0.1", "localhost"));
    expect(t.methods()).toEqual([AUTH_METHODS.start, AUTH_METHODS.complete]);
  });

  test("any other message while pending routes normally, and the login stays pending", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    await t.send("what's the weather?");
    await t.send("https://example.com/auth/callback?code=x");
    expect(t.methods()).toEqual([AUTH_METHODS.start, RPC_METHODS.chatMessage, RPC_METHODS.chatMessage]);
    expect(t.link.isLoginPending()).toBe(true);
  });

  test("a callback with no login pending is sent nowhere and says so", async () => {
    const t = setupLogin();
    await t.send(PASTE);
    expect(t.methods()).toEqual([]);
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginCallbackIgnored" }]);
    expect(t.discord.of("fallbackReply")).toEqual([]);
    expect(t.store.listInbox(P)).toEqual([]);
  });

  test("a callback with no login pending while offline never reaches the fallback agent", async () => {
    const t = setupLogin();
    t.rpc.connected = false;
    await t.send(`<${PASTE}>`);
    expect(t.discord.of("fallbackReply")).toEqual([]);
    expect(t.store.listInbox(P)).toEqual([]);
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginCallbackIgnored" }]);
  });

  test("pending expires with the workspace's login timeout; a later paste still goes nowhere", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    t.advance(LOGIN_PENDING_MS);
    expect(t.link.isLoginPending()).toBe(false);
    await t.send(PASTE);
    expect(t.methods()).toEqual([AUTH_METHODS.start]);
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginCallbackIgnored" }]);
  });

  test("after a failed paste ends the login, a second paste goes nowhere", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    t.rpc.replies[AUTH_METHODS.complete] = () => ({ ok: false, error: "OAuth state mismatch" });
    await t.send(PASTE.slice(0, 50));
    await t.send(PASTE);
    expect(t.methods()).toEqual([AUTH_METHODS.start, AUTH_METHODS.complete]);
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginCallbackIgnored" }]);
  });

  test("a paste the workspace turns away keeps the login pending, explains why, and a second paste still reaches it", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    const reason = "the path must be exactly /auth/callback (lowercase) — copy the address as the browser shows it";
    t.rpc.replies[AUTH_METHODS.complete] = () => ({ ok: false, error: reason, retry: true });
    await t.send(PASTE.replace("/auth/callback", "/AUTH/CALLBACK"));
    expect(t.methods()).toEqual([AUTH_METHODS.start, AUTH_METHODS.complete]);
    expect(t.rpc.calls[1]!.params).toEqual({ principalId: P, input: PASTE.replace("/auth/callback", "/AUTH/CALLBACK") });
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginCallbackRejected", error: reason }]);
    expect(t.link.isLoginPending()).toBe(true);

    t.rpc.replies[AUTH_METHODS.complete] = () => ({ ok: true, model: "gpt-6.1-sol" });
    await t.send(PASTE);
    expect(t.methods()).toEqual([AUTH_METHODS.start, AUTH_METHODS.complete, AUTH_METHODS.complete]);
    expect(t.link.isLoginPending()).toBe(false);
    expect(t.discord.of("fallbackReply")).toEqual([]);
    expect(t.store.listInbox(P)).toEqual([]);
    expect(JSON.stringify(t.logs)).not.toContain(CODE);
  });

  test("owner-only: another user's !login is not a login, and their paste goes nowhere", async () => {
    const t = setupLogin({ isOwner: false });
    await t.send("!login chatgpt");
    expect(t.methods()).toEqual([RPC_METHODS.chatMessage]);
    expect(t.link.isLoginPending()).toBe(false);
    await t.send(PASTE);
    expect(t.methods()).toEqual([RPC_METHODS.chatMessage]);
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginCallbackIgnored" }]);
  });

  describe("every way of pasting the callback reaches only auth/complete, as the bare URL", () => {
    const bare = PASTE;
    const noScheme = PASTE.replace("http://", "");
    const variants: Array<[string, string, string]> = [
      ["bare", bare, bare],
      ["angle brackets", `<${bare}>`, bare],
      ["backticks", `\`${bare}\``, bare],
      ["code fence", `\`\`\`\n${bare}\n\`\`\``, bare],
      ["surrounding text", `here: ${bare} thanks`, bare],
      ["glued label", `here:${bare}`, bare],
      ["trailing period", `${bare}.`, bare],
      ["parentheses", `(${bare})`, bare],
      ["spoiler", `||${bare}||`, bare],
      ["markdown link", `[link](${bare})`, bare],
      ["missing scheme", noScheme, bare],
      ["missing scheme in text", `it went to ${noScheme}`, bare],
      ["localhost", bare.replace("127.0.0.1", "localhost"), bare.replace("127.0.0.1", "localhost")],
      ["localhost no scheme", noScheme.replace("127.0.0.1", "localhost"), bare.replace("127.0.0.1", "localhost")],
      ["uppercase", bare.toUpperCase(), bare.toUpperCase()],
      ["https", bare.replace("http:", "https:"), bare.replace("http:", "https:")],
      ["other host on :1455", bare.replace("127.0.0.1", "0.0.0.0"), bare.replace("127.0.0.1", "0.0.0.0")],
      ["other host with code and state", `https://example.com/auth/callback?code=${CODE}&state=s1`, `https://example.com/auth/callback?code=${CODE}&state=s1`],
      ["host:port with a code but no path", `127.0.0.1:1455/?code=${CODE}&state=s1`, `http://127.0.0.1:1455/?code=${CODE}&state=s1`],
      ["base64url code ending in _ and -", `<${bare.replace(CODE, "abc_-")}>`, bare.replace(CODE, "abc_-")],
    ];
    for (const [name, text, expected] of variants) {
      test(name, async () => {
        const t = setupLogin();
        await t.send("!login chatgpt");
        await t.send(text);
        expect(t.methods()).toEqual([AUTH_METHODS.start, AUTH_METHODS.complete]);
        expect(t.rpc.calls[1]!.params).toEqual({ principalId: P, input: expected });
        expect(detectLoginCallback(text)).toEqual({ url: expected });
      });
    }

    test("ordinary text is not a callback", () => {
      for (const text of ["what's the weather?", "https://example.com/auth/callback?code=x", "the page at localhost:1455 won't load", "my app's localhost:3000/auth/callback 404s", "!login chatgpt", "code=1&state=2"]) {
        expect(detectLoginCallback(text)).toBeNull();
      }
    });
  });

  test("a resent result of an earlier login does not end a newer one", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    await t.deliver({ outboxId: "r1", kind: "reply", text: "❌ failed", origin: DISCORD, authResult: "failed", loginId: "L1" });
    await tick();
    expect(t.link.isLoginPending()).toBe(false);
    t.rpc.replies[AUTH_METHODS.start] = () => ({ started: true, loginId: "L2" });
    await t.send("!login chatgpt");
    await t.deliver({ outboxId: "r1", kind: "reply", text: "❌ failed", origin: DISCORD, authResult: "failed", loginId: "L1" });
    await tick();
    expect(t.link.isLoginPending()).toBe(true);
    // An unseen result with the wrong id doesn't either; the matching one does.
    await t.deliver({ outboxId: "r9", kind: "reply", text: "❌ failed", origin: DISCORD, authResult: "failed", loginId: "L1" });
    await tick();
    expect(t.link.isLoginPending()).toBe(true);
    await t.send(PASTE);
    expect(t.methods().filter((m) => m === RPC_METHODS.chatMessage)).toEqual([]);
    expect(t.methods().at(-1)).toBe(AUTH_METHODS.complete);
  });

  test("a result with no loginId leaves pending alone", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    await t.deliver({ outboxId: "r1", kind: "reply", text: "⌛", origin: DISCORD, authResult: "timeout" });
    await tick();
    expect(t.link.isLoginPending()).toBe(true);
  });

  test("pending is set before auth/start answers", async () => {
    const t = setupLogin();
    const seen: { pending?: boolean } = {};
    t.rpc.replies[AUTH_METHODS.start] = () => {
      seen.pending = t.link.isLoginPending();
      return { started: true, loginId: "L1" };
    };
    await t.send("!login chatgpt");
    expect(seen.pending).toBe(true);
  });

  test("an unanswered auth/start keeps pending, so the sign-in link's paste is still intercepted", async () => {
    const t = setupLogin();
    t.rpc.replies[AUTH_METHODS.start] = () => {
      throw new RpcTimeoutError("auth/start timed out after 30000ms");
    };
    await t.send("!login chatgpt");
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginFailed", error: "auth/start timed out after 30000ms" }]);
    expect(t.link.isLoginPending()).toBe(true);
    await t.deliver({ outboxId: "a1", kind: "auth", text: "Sign in", origin: DISCORD, auth: { url: "https://auth.openai.com/x", instructions: "paste" }, loginId: "L1" });
    await tick();
    await t.send(PASTE);
    expect(t.methods()).toEqual([AUTH_METHODS.start, RPC_METHODS.chatAck, AUTH_METHODS.complete]);
  });

  test("an explicit auth/start refusal rolls pending back", async () => {
    const t = setupLogin();
    t.rpc.replies[AUTH_METHODS.start] = () => {
      throw new Error("provider unavailable");
    };
    await t.send("!login chatgpt");
    expect(t.link.isLoginPending()).toBe(false);
  });

  test("a first-seen sign-in link marks its login pending even when auth/start's answer was lost", async () => {
    const t = setupLogin();
    await t.deliver({ outboxId: "a1", kind: "auth", text: "Sign in", origin: DISCORD, auth: { url: "https://auth.openai.com/x", instructions: "paste" }, loginId: "L7" });
    await tick();
    expect(t.link.isLoginPending()).toBe(true);
    await t.deliver({ outboxId: "r1", kind: "reply", text: "ok", origin: DISCORD, authResult: "ok", loginId: "L7" });
    await tick();
    expect(t.link.isLoginPending()).toBe(false);
  });

  test("the legacy numeric pending value still counts", () => {
    const t = setupLogin();
    t.store.setKv("workspace:login_pending:" + P, String(1_000_000 + 60_000));
    expect(t.link.isLoginPending()).toBe(true);
  });

  test("offline: the notice, and no request", async () => {
    const t = setupLogin();
    t.rpc.connected = false;
    await t.send("!login chatgpt");
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginOffline" }]);
    expect(t.rpc.calls).toEqual([]);

    const disabled = setupLogin({ workspaceEnabled: false });
    await disabled.send("!login chatgpt");
    expect(disabled.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginOffline" }]);
  });

  test("a paste while pending but offline is still kept from the fallback agent", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    t.rpc.connected = false;
    await t.send(PASTE);
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginOffline" }]);
    expect(t.discord.of("fallbackReply")).toEqual([]);
    expect(t.store.listInbox(P)).toEqual([]);
    expect(t.link.isLoginPending()).toBe(true);
  });

  test("double start: the notice, and the paste is still intercepted", async () => {
    const t = setupLogin();
    t.rpc.replies[AUTH_METHODS.start] = () => {
      throw new Error(LOGIN_ALREADY_PENDING);
    };
    await t.send("!login chatgpt");
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginAlreadyPending" }]);
    expect(t.link.isLoginPending()).toBe(true);
  });

  test("!login cancel cancels and clears pending; with none running it says so", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    await t.send("!login cancel");
    expect(t.methods()).toEqual([AUTH_METHODS.start, AUTH_METHODS.cancel]);
    expect(t.discord.of("ack").map((c) => c.arg)).toEqual(["accepted", "stopped"]);
    expect(t.link.isLoginPending()).toBe(false);

    t.rpc.replies[AUTH_METHODS.cancel] = () => ({ cancelled: false });
    await t.send("!login cancel");
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginNotPending" }]);
  });

  test("an unknown !login argument gets the usage line", async () => {
    const t = setupLogin();
    await t.send("!login claude");
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginUsage" }]);
    expect(t.rpc.calls).toEqual([]);
  });

  test("a paste the workspace has no login for gets the sent-nowhere notice", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    t.rpc.replies[AUTH_METHODS.complete] = () => ({ ok: false, error: "none", inactive: true });
    await t.send(PASTE);
    expect(t.discord.of("notice").map((c) => c.arg)).toEqual([{ type: "loginCallbackIgnored" }]);
  });

  test("the auth delivery renders the sign-in prompt; the result reply clears pending", async () => {
    const t = setupLogin();
    await t.send("!login chatgpt");
    await t.deliver({ outboxId: "a1", kind: "auth", text: "Sign in with ChatGPT", origin: DISCORD, auth: { url: "https://auth.openai.com/x", instructions: "paste it" } });
    await tick();
    expect(t.discord.of("authPrompt")).toEqual([{ method: "authPrompt", origin: DISCORD, arg: { url: "https://auth.openai.com/x", instructions: "paste it" } }]);
    expect(t.link.isLoginPending()).toBe(true);

    await t.deliver({ outboxId: "a2", kind: "reply", text: "⌛ timed out", origin: DISCORD, authResult: "timeout", loginId: "L1" });
    await tick();
    expect(t.discord.of("sendReply").map((c) => (c.arg as ReplyView).text)).toEqual(["⌛ timed out"]);
    expect(t.link.isLoginPending()).toBe(false);
  });
});

describe("upload/read through the link", () => {
  test("is refused when no upload store is wired", async () => {
    const { rpc } = setup();
    const res = await rpc.handler!.onRequest!(CONN, RPC_METHODS.uploadRead, { principalId: P, uploadId: "A".repeat(22) });
    expect(res).toEqual({ ok: false, error: "web uploads are not configured on the bot" });
  });

  test("goes to the wired handler even with DM_WORKSPACE_ENABLED off", async () => {
    const seen: unknown[] = [];
    const rpc = new FakeRpc();
    const link = new WorkspaceLink({
      principalId: P,
      store: newStore(),
      surfaces: new SurfaceRegistry("test").register(new FakeAdapter("test")),
      owner: () => ({ id: "owner-1", name: "drk" }),
      timers: immediate,
      enabled: false,
      uploadRead: async (_conn, params) => {
        seen.push(params);
        return { ok: false, error: "not found" };
      },
    });
    link.attach(rpc);
    const params = { principalId: P, uploadId: "A".repeat(22) };
    expect(await rpc.handler!.onRequest!(CONN, RPC_METHODS.uploadRead, params)).toEqual({ ok: false, error: "not found" });
    expect(seen).toEqual([params]);
  });
});
