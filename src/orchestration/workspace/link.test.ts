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
  }

  async sendReply(origin: ChatOrigin | null, reply: ReplyView, _attempt: SendAttempt): Promise<void> {
    this.check();
    this.calls.push({ method: "sendReply", origin, arg: reply });
  }
  async askPrompt(origin: ChatOrigin | null, ask: AskView, _attempt: SendAttempt): Promise<void> {
    this.calls.push({ method: "askPrompt", origin, arg: ask });
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
    expect(() => registry.assertPreferredRegistered()).not.toThrow();
    const typo = new SurfaceRegistry("discrod").register(new FakeAdapter("discord"));
    expect(() => typo.assertPreferredRegistered()).toThrow('WORKSPACE_PREFERRED_SURFACE "discrod" has no adapter; registered: discord');
  });
});
