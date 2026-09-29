import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { RPC_METHODS, chatEventParams, type ChatDeliverParams, type ChatEventPayload } from "../../orchestration/contracts.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../../orchestration/transport/server.ts";
import { DELIVERY_MAX_FAILURES, WorkspaceLink, type WorkspaceRpc } from "../../orchestration/workspace/link.ts";
import { formatDuration, progressEditDelay, type Timers } from "../../orchestration/workspace/progress.ts";
import { SurfaceRegistry } from "../../orchestration/workspace/surface.ts";
import { DiscordWorkspaceAdapter, answeredAsk, progressEditGap, renderDelivery, renderProgressFinal, type DmChannelPort } from "./workspaceAdapter.ts";

const P = "drk";
const ORIGIN = { surface: "discord", conversationId: "dm-1" };

function discordSurfaces(ownerChannel: () => Promise<unknown>): SurfaceRegistry {
  return new SurfaceRegistry("discord").register(new DiscordWorkspaceAdapter({ ownerChannel: ownerChannel as () => Promise<DmChannelPort | null> }));
}
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "idle" };

type Call = { method: string; params: unknown };

class FakeRpc implements WorkspaceRpc {
  connected = true;
  handler: WorkspaceHandler | null = null;
  calls: Call[] = [];
  log: string[];
  respond: (method: string, params: unknown) => Promise<unknown> = async () => ({});
  constructor(log: string[]) {
    this.log = log;
  }
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined {
    return this.connected && principalId === P ? CONN : undefined;
  }
  requestWorkspace(_p: string, method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    this.log.push(`rpc:${method}`);
    return this.respond(method, params);
  }
  setWorkspaceHandler(handler: WorkspaceHandler | null): void {
    this.handler = handler;
  }
}

function textOf(options: MessageCreateOptions | MessageEditOptions): string {
  return JSON.stringify((options.components ?? []).map((c) => ("toJSON" in c ? c.toJSON() : c)));
}

class FakeChannel {
  sent: MessageCreateOptions[] = [];
  edits: MessageEditOptions[][] = [];
  failNext = false;
  failWhen: ((options: MessageCreateOptions) => boolean) | null = null;
  constructor(private readonly log: string[]) {}
  async send(options: MessageCreateOptions) {
    if (this.failNext || this.failWhen?.(options)) {
      this.failNext = false;
      throw new Error("discord down");
    }
    const idx = this.sent.length;
    this.sent.push(options);
    this.edits.push([]);
    this.log.push("discord:send");
    return {
      edit: async (o: MessageEditOptions) => {
        this.edits[idx]!.push(o);
        this.log.push("discord:edit");
      },
    };
  }
}

class ManualTimers implements Timers {
  private next = 1;
  pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fireAll(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const t of all) t.fn();
  }
}

function setup() {
  const log: string[] = [];
  const db = new Database(":memory:");
  applySchema(db);
  const store = new WorkspaceLinkStore(db);
  const rpc = new FakeRpc(log);
  const channel = new FakeChannel(log);
  const timers = new ManualTimers();
  let now = 1_000_000;
  const link = new WorkspaceLink({
    principalId: P,
    store,
    surfaces: discordSurfaces(async () => channel),
    owner: () => ({ id: "owner-1", name: "drk" }),
    now: () => now,
    timers,
  });
  link.attach(rpc);
  return { link, rpc, channel, store, timers, log, advance: (ms: number) => (now += ms), nowMs: () => now };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function deliverParams(overrides: Partial<ChatDeliverParams> = {}): ChatDeliverParams {
  return { outboxId: "o1", principalId: P, kind: "reply", text: "hello there", ...overrides };
}

async function deliverViaServer(rpc: FakeRpc, params: ChatDeliverParams): Promise<unknown> {
  return rpc.handler!.onRequest!(CONN, RPC_METHODS.chatDeliver, params);
}

function event(rpc: FakeRpc, turnId: string, ev: ChatEventPayload): void {
  rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { principalId: P, turnId, agentId: "main", ev });
}

describe("progress edit schedule", () => {
  test("gap grows with turn age", () => {
    expect(progressEditGap(0)).toBe(3_000);
    expect(progressEditGap(29_999)).toBe(3_000);
    expect(progressEditGap(30_000)).toBe(10_000);
    expect(progressEditGap(119_999)).toBe(10_000);
    expect(progressEditGap(120_000)).toBe(30_000);
    expect(progressEditGap(599_999)).toBe(30_000);
    expect(progressEditGap(600_000)).toBe(60_000);
  });

  test("delay is what's left of the gap since the last edit, never negative", () => {
    expect(progressEditDelay({ now: 1_000, startedAt: 0, lastEditAt: 0 }, progressEditGap)).toBe(2_000);
    expect(progressEditDelay({ now: 5_000, startedAt: 0, lastEditAt: 0 }, progressEditGap)).toBe(0);
    expect(progressEditDelay({ now: 45_000, startedAt: 0, lastEditAt: 40_000 }, progressEditGap)).toBe(5_000);
    expect(progressEditDelay({ now: 700_000, startedAt: 0, lastEditAt: 690_000 }, progressEditGap)).toBe(50_000);
  });

  test("formatDuration", () => {
    expect(formatDuration(52_000)).toBe("52s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});

describe("chat/deliver", () => {
  test("replies {} immediately, sends to Discord, then acks", async () => {
    const { rpc, channel, log } = setup();
    expect(await deliverViaServer(rpc, deliverParams({ usage: { model: "m", inputTokens: 10, outputTokens: 2300, contextPct: 41.2, costUsd: 0.041 } }))).toEqual({});
    await tick();
    await tick();
    expect(channel.sent).toHaveLength(1);
    const body = textOf(channel.sent[0]!);
    expect(body).toContain("hello there");
    expect(body).toContain("-# m · ctx 41% · 2,300 out · $0.0410");
    expect(log).toEqual(["discord:send", `rpc:${RPC_METHODS.chatAck}`]);
    expect(rpc.calls.at(-1)).toEqual({ method: RPC_METHODS.chatAck, params: { outboxId: "o1" } });
  });

  test("a second delivery with the same outboxId re-acks without re-sending", async () => {
    const { link, rpc, channel } = setup();
    await link.deliver(deliverParams());
    await link.deliver(deliverParams());
    expect(channel.sent).toHaveLength(1);
    expect(rpc.calls.filter((c) => c.method === RPC_METHODS.chatAck)).toHaveLength(2);
  });

  test("concurrent resends of one outboxId post once", async () => {
    const { link, channel } = setup();
    await Promise.all([link.deliver(deliverParams()), link.deliver(deliverParams())]);
    expect(channel.sent).toHaveLength(1);
  });

  test("a failed Discord send is neither recorded nor acked", async () => {
    const { link, rpc, channel, store } = setup();
    channel.failNext = true;
    await link.deliver(deliverParams());
    expect(rpc.calls).toHaveLength(0);
    expect(store.hasSeenOutbox("o1")).toBe(false);
    await link.deliver(deliverParams());
    expect(channel.sent).toHaveLength(1);
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck]);
  });

  test("proactive gets the ⏰ prefix; ask renders a button per choice", async () => {
    const { link, channel } = setup();
    await link.deliver(deliverParams({ outboxId: "p1", kind: "proactive", text: "morning check" }));
    expect(textOf(channel.sent[0]!)).toContain("-# ⏰\\nmorning check");
    await link.deliver(deliverParams({ outboxId: "a1", kind: "ask", text: "q", ask: { askId: "ask9", question: "Merge now?", choices: ["Merge now", "Wait"] } }));
    const ask = textOf(channel.sent[1]!);
    expect(ask).toContain("Merge now?");
    expect(ask).toContain('"custom_id":"wsask:ask9:0"');
    expect(ask).toContain('"custom_id":"wsask:ask9:1"');
    expect(link.askChoice("ask9", 1, null)).toBe("Wait");
    expect(link.askChoice("unknown", 0, "Label")).toBe("Label");
  });

  test("an answered ask keeps its question and drops the buttons", async () => {
    const { link } = setup();
    const [ask] = renderDelivery(deliverParams({ kind: "ask", ask: { askId: "a", question: "Merge now?", choices: ["Yes", "No"] } }));
    const edited = textOf(answeredAsk({ components: ask!.components as Array<{ toJSON(): unknown }> }, "Yes"));
    expect(edited).toContain("Merge now?");
    expect(edited).toContain("-# → Yes");
    expect(edited).not.toContain("wsask:");
  });

  test("a reply with a turnId finalizes that turn's open progress view and shows its tool count", async () => {
    const { link, rpc, channel } = setup();
    event(rpc, "t1", { type: "tool_start", name: "bash", summary: "" });
    event(rpc, "t1", { type: "tool_end", name: "bash", ok: true });
    event(rpc, "t1", { type: "tool_start", name: "read", summary: "" });
    await tick();
    await link.deliver(deliverParams({ turnId: "t1", usage: { model: "m", inputTokens: 1, outputTokens: 5 } }));
    await link.settled();
    expect(textOf(channel.edits[0]!.at(-1)!)).toContain("✓ done · 0s · 2 tools");
    expect(link.hasTurn("t1")).toBe(false);
    expect(textOf(channel.sent[1]!)).toContain("-# m · 5 out · 2 tools");
  });

  test("turn_end before the delivery: the reply footer still carries the count; none for a tool-less turn", async () => {
    const { link, rpc, channel } = setup();
    event(rpc, "t1", { type: "tool_start", name: "bash", summary: "" });
    event(rpc, "t1", { type: "turn_end", aborted: false });
    await tick();
    await link.deliver(deliverParams({ outboxId: "o1", turnId: "t1" }));
    expect(textOf(channel.sent.at(-1)!)).toContain("-# 1 tool");

    event(rpc, "t2", { type: "turn_start" });
    event(rpc, "t2", { type: "turn_end", aborted: false });
    await link.deliver(deliverParams({ outboxId: "o2", turnId: "t2", usage: { model: "m", inputTokens: 1, outputTokens: 5 } }));
    const last = textOf(channel.sent.at(-1)!);
    expect(last).toContain("-# m · 5 out");
    expect(last).not.toContain("tool");
  });

  test("a partial multi-page send resends only the missing pages", async () => {
    const { link, rpc, channel } = setup();
    const text = Array.from({ length: 3 }, (_, i) => `section ${i}\n${"x".repeat(3000)}`).join("\n\n");
    let sends = 0;
    channel.failWhen = () => ++sends === 2;
    await link.deliver(deliverParams({ text }));
    expect(channel.sent).toHaveLength(1);
    expect(rpc.calls).toHaveLength(0);
    await link.deliver(deliverParams({ text }));
    const bodies = channel.sent.map((m) => textOf(m));
    expect(bodies.filter((b) => b.includes("section 0"))).toHaveLength(1);
    expect(bodies.some((b) => b.includes("section 2"))).toBe(true);
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck]);
  });

  test("a delivery Discord keeps rejecting goes out as plain text after repeated failures across restarts, then is acked", async () => {
    const { rpc, channel, store } = setup();
    channel.failWhen = (o) => o.content === undefined;
    // Each resend follows a register, usually after a bot restart: a fresh link over the same store.
    const freshLink = () => {
      const link = new WorkspaceLink({ principalId: P, store, surfaces: discordSurfaces(async () => channel), owner: () => ({ id: "owner-1", name: "drk" }) });
      link.attach(rpc);
      return link;
    };
    for (let i = 0; i < DELIVERY_MAX_FAILURES - 1; i++) await freshLink().deliver(deliverParams());
    expect(rpc.calls).toHaveLength(0);
    await freshLink().deliver(deliverParams());
    expect(channel.sent.map((m) => m.content)).toEqual(["hello there"]);
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck]);
    expect(store.getKv("workspace:deliver_failures:o1")).toBeNull();
  });

  test("an ask with an overlong question or empty choice still renders valid components", async () => {
    const { link, channel } = setup();
    await link.deliver(deliverParams({ kind: "ask", ask: { askId: "a", question: "q".repeat(5000), choices: ["", "  ", "ok"] } }));
    const [ask] = channel.sent;
    const body = textOf(ask!);
    const content = JSON.parse(body)[0].components[0].content as string;
    expect(content.length).toBeLessThanOrEqual(4000);
    expect(body).toContain('"label":"(option 1)"');
    expect(body).toContain('"label":"(option 2)"');
    expect(link.askChoice("a", 0, null)).toBe("(option 1)");
  });

  test("a delivery for another principal is refused", async () => {
    const { rpc, channel } = setup();
    await expect(deliverViaServer(rpc, deliverParams({ principalId: "mallory" }))).rejects.toThrow("principal mismatch");
    await tick();
    expect(channel.sent).toHaveLength(0);
  });
});

describe("inbox replay", () => {
  test("register replays offline exchanges oldest-first as context and deletes each once accepted", async () => {
    const { link, rpc, store } = setup();
    rpc.connected = false;
    link.recordOffline("first q", "first a", ORIGIN);
    link.recordOffline("second q", "second a", ORIGIN);
    rpc.connected = true;
    rpc.respond = async () => ({ accepted: true, mode: "context" });
    rpc.handler!.onRegister!(CONN);
    await link.replayInbox();
    const sent = rpc.calls.filter((c) => c.method === RPC_METHODS.chatMessage).map((c) => c.params as { messageId: string; kind: string; text: string });
    expect(sent.map((s) => s.kind)).toEqual(["context", "context"]);
    expect(sent[0]!.text).toBe("User: first q\nAssistant (offline fallback): first a");
    expect(sent[1]!.text).toBe("User: second q\nAssistant (offline fallback): second a");
    expect(sent[0]!.messageId).toMatch(/^inbox:\d+$/);
    expect(store.listInbox(P)).toHaveLength(0);
  });

  test("a rejected row stops the replay and stays for the next register", async () => {
    const { link, rpc, store } = setup();
    rpc.connected = false;
    link.recordOffline("q1", "a1", ORIGIN);
    link.recordOffline("q2", "a2", ORIGIN);
    rpc.connected = true;
    rpc.respond = async () => {
      throw new Error("link closed");
    };
    await link.replayInbox();
    expect(rpc.calls).toHaveLength(1);
    expect(store.listInbox(P).map((r) => r.userText)).toEqual(["q1", "q2"]);
  });

  test("a re-register while a replay is in flight on the old socket replays again on the new one", async () => {
    const { link, rpc, store } = setup();
    rpc.connected = false;
    link.recordOffline("q1", "a1", ORIGIN);
    rpc.connected = true;
    let rejectOld!: (err: Error) => void;
    rpc.respond = () => new Promise((_, reject) => (rejectOld = reject));
    rpc.handler!.onRegister!(CONN);
    await tick();
    // The socket is replaced: the new register fires before the old call dies with "connection closed".
    rpc.respond = async () => ({ accepted: true, mode: "context" });
    rpc.handler!.onRegister!(CONN);
    rejectOld(new Error("connection closed"));
    for (let i = 0; i < 5; i++) await tick();
    expect(rpc.calls.filter((c) => c.method === RPC_METHODS.chatMessage)).toHaveLength(2);
    expect(store.listInbox(P)).toHaveLength(0);
  });
});

describe("live progress", () => {
  test("no message on turn_start; created on first tool_start; edits coalesce; turn_end edits immediately", async () => {
    const { rpc, channel, timers, advance, link } = setup();
    event(rpc, "t1", { type: "turn_start" });
    await tick();
    expect(channel.sent).toHaveLength(0);

    event(rpc, "t1", { type: "tool_start", name: "bash", summary: "rg -n WIKI" });
    await tick();
    expect(channel.sent).toHaveLength(1);
    const first = textOf(channel.sent[0]!);
    expect(first).toMatch(/⏳ working · started <t:\d+:R>/);
    expect(first).toContain("-# ⏳ working");
    expect(first).toContain("… `bash` rg -n WIKI");
    expect(first).toContain('"custom_id":"wsstop:t1"');

    advance(500);
    event(rpc, "t1", { type: "tool_end", name: "bash", ok: true });
    event(rpc, "t1", { type: "tool_start", name: "edit", summary: "vars.yml" });
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending.values()][0]!.ms).toBe(2_500);
    timers.fireAll();
    await link.settled();
    expect(channel.edits[0]).toHaveLength(1);
    const edited = textOf(channel.edits[0]![0]!);
    expect(edited).toContain("✓ `bash`");
    expect(edited).toContain("… `edit` vars.yml");

    advance(1_000);
    event(rpc, "t1", { type: "tool_end", name: "edit", ok: false });
    expect(timers.pending.size).toBe(1);
    advance(51_000);
    event(rpc, "t1", { type: "turn_end", aborted: false });
    expect(timers.pending.size).toBe(0);
    await tick();
    await tick();
    expect(channel.edits[0]).toHaveLength(2);
    const final = textOf(channel.edits[0]![1]!);
    expect(final).toContain("✓ done · 53s · 2 tools");
    expect(final).not.toContain("wsstop");
  });

  test("aborted turn ends as stopped with danger accent; a tool-less stopped turn still gets a message", async () => {
    const { rpc, channel } = setup();
    event(rpc, "t2", { type: "tool_start", name: "bash", summary: "" });
    event(rpc, "t2", { type: "turn_end", aborted: true });
    await tick();
    await tick();
    expect(textOf(channel.edits[0]!.at(-1)!)).toContain("⏹ stopped");
    expect(textOf(channel.edits[0]!.at(-1)!)).toContain(`"accent_color":${0xf23f43}`);

    event(rpc, "t3", { type: "turn_start" });
    event(rpc, "t3", { type: "turn_end", aborted: true });
    await tick();
    expect(channel.sent).toHaveLength(2);
    expect(textOf(channel.sent[1]!)).toContain("⏹ stopped · 0s · 0 tools");
  });

  test("a quick tool-less reply leaves no progress message", async () => {
    const { rpc, channel } = setup();
    event(rpc, "t4", { type: "turn_start" });
    event(rpc, "t4", { type: "text_delta", text: "hi" });
    event(rpc, "t4", { type: "turn_end", aborted: false });
    await tick();
    expect(channel.sent).toHaveLength(0);
  });

  test("an idle re-register closes turns still shown as working", async () => {
    const { rpc, channel } = setup();
    event(rpc, "t5", { type: "tool_start", name: "bash", summary: "" });
    await tick();
    rpc.handler!.onRegister!({ ...CONN, state: "idle" });
    await tick();
    await tick();
    expect(textOf(channel.edits[0]!.at(-1)!)).toContain("⚠️ interrupted");
  });

  test("abort carries the turnId", async () => {
    const { link, rpc } = setup();
    rpc.respond = async () => ({ aborted: true });
    await link.abort("t9");
    await link.abort();
    expect(rpc.calls.map((c) => c.params)).toEqual([{ principalId: P, turnId: "t9" }, { principalId: P }]);
  });

  test("a turn a Stop button already finalized gets no second stopped message", async () => {
    const { link, rpc, channel } = setup();
    link.markTurnEnded("t7");
    event(rpc, "t7", { type: "turn_end", aborted: true });
    await tick();
    expect(channel.sent).toHaveLength(0);
    expect(textOf(renderProgressFinal({ outcome: "interrupted", summary: null }))).toContain('"content":"⚠️ interrupted"');
  });

  test("events for another principal are ignored", async () => {
    const { rpc, channel } = setup();
    rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { principalId: "mallory", turnId: "x", agentId: "main", ev: { type: "tool_start", name: "a", summary: "" } });
    await tick();
    expect(channel.sent).toHaveLength(0);
  });
});

describe("connection wait", () => {
  test("waitForConnection resolves on register, or false after the timeout", async () => {
    const { link, rpc, timers } = setup();
    rpc.connected = false;
    const waiting = link.waitForConnection(15_000);
    rpc.connected = true;
    rpc.handler!.onRegister!(CONN);
    expect(await waiting).toBe(true);

    rpc.connected = false;
    const timingOut = link.waitForConnection(15_000);
    timers.fireAll();
    expect(await timingOut).toBe(false);
  });
});

describe("bot-proxied tools", () => {
  function withTools() {
    const db = new Database(":memory:");
    applySchema(db);
    const seen: string[] = [];
    const rpc = new FakeRpc([]);
    const link = new WorkspaceLink({
      principalId: P,
      store: new WorkspaceLinkStore(db),
      surfaces: discordSurfaces(async () => null),
      owner: () => ({ id: "owner-1", name: "drk" }),
      tools: {
        manifest: () => [{ name: "web_search", description: "d", inputSchema: { type: "object" }, approval: "none" }],
        handleCall: async (_conn, params) => {
          seen.push(`call:${(params as { name: string }).name}`);
          return { ok: true, result: "r" };
        },
        onSocketClosed: (conn) => void seen.push(`closed:${conn.runnerId}`),
      },
    });
    link.attach(rpc);
    return { handler: rpc.handler!, seen };
  }

  test("tool/call, the manifest and socket closes route to the tools port", async () => {
    const { handler, seen } = withTools();
    expect(await handler.onRequest!(CONN, RPC_METHODS.toolCall, { name: "web_search" })).toEqual({ ok: true, result: "r" });
    expect(handler.toolManifest!(CONN).map((t) => t.name)).toEqual(["web_search"]);
    expect(handler.toolManifest!({ ...CONN, principalId: "someone-else" })).toEqual([]);
    handler.onSocketClosed!(CONN);
    expect(seen).toEqual(["call:web_search", `closed:${CONN.runnerId}`]);
  });

  test("without a tools port, tool/call is method-not-found and the manifest is empty", async () => {
    const { rpc } = setup();
    await expect(rpc.handler!.onRequest!(CONN, RPC_METHODS.toolCall, {})).rejects.toThrow("method not found");
    expect(rpc.handler!.toolManifest!(CONN)).toEqual([]);
  });
});

class IdChannel {
  msgs = new Map<string, { sent: MessageCreateOptions; edits: MessageEditOptions[] }>();
  order: string[] = [];
  fetchMessage?: (id: string) => Promise<{ id: string; edit(o: MessageEditOptions): Promise<unknown> } | null>;
  private seq = 0;
  constructor(fetchable = true) {
    if (fetchable) this.fetchMessage = async (id) => (this.msgs.has(id) ? this.handle(id) : null);
  }
  async send(options: MessageCreateOptions) {
    const id = `m${++this.seq}`;
    this.msgs.set(id, { sent: options, edits: [] });
    this.order.push(id);
    return this.handle(id);
  }
  private handle(id: string) {
    return { id, edit: async (o: MessageEditOptions) => void this.msgs.get(id)!.edits.push(o) };
  }
  current(id: string): string {
    const m = this.msgs.get(id)!;
    return textOf(m.edits.at(-1) ?? m.sent);
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

describe("progress views survive a bot restart", () => {
  function processes(channel: IdChannel) {
    const db = new Database(":memory:");
    applySchema(db);
    const store = new WorkspaceLinkStore(db);
    const start = () => {
      const rpc = new FakeRpc([]);
      const link = new WorkspaceLink({ principalId: P, store, surfaces: discordSurfaces(async () => channel), owner: () => ({ id: "owner-1", name: "drk" }), timers: new ManualTimers() });
      link.attach(rpc);
      return { link, rpc };
    };
    return { start, store };
  }

  test("streaming re-register: the same turn keeps editing the old message, and the reply gets the full tool count", async () => {
    const channel = new IdChannel();
    const { start } = processes(channel);
    const bot1 = start();
    event(bot1.rpc, "t1", { type: "tool_start", name: "bash", summary: "sleep 30" });
    await settle();
    event(bot1.rpc, "t1", { type: "tool_end", name: "bash", ok: true });
    event(bot1.rpc, "t1", { type: "tool_start", name: "read", summary: "" });
    await settle();

    const bot2 = start(); // restart: fresh process, same DB
    bot2.rpc.handler!.onRegister!({ ...CONN, state: "streaming" });
    expect(bot2.link.hasTurn("t1")).toBe(true);
    event(bot2.rpc, "t1", { type: "tool_start", name: "grep", summary: "" });
    await settle();
    expect(channel.order).toEqual(["m1"]);

    await bot2.link.deliver(deliverParams({ outboxId: "r1", turnId: "t1", text: "all done" }));
    await settle();
    expect(channel.order).toHaveLength(2);
    expect(channel.current("m1")).toContain("✓ done");
    expect(channel.current("m1")).toContain("3 tools");
    expect(channel.current("m2")).toContain("3 tools");
  });

  test("idle re-register: the stale view is finalized, then marked done when its reply arrives with the count", async () => {
    const channel = new IdChannel();
    const { start } = processes(channel);
    const bot1 = start();
    event(bot1.rpc, "t2", { type: "tool_start", name: "bash", summary: "" });
    await settle();

    const bot2 = start();
    bot2.rpc.handler!.onRegister!({ ...CONN, state: "idle" });
    await settle();
    expect(channel.current("m1")).toContain("⚠️ interrupted");
    expect(channel.current("m1")).not.toContain("wsstop:");

    await bot2.link.deliver(deliverParams({ outboxId: "r2", turnId: "t2", text: "finished while you were away" }));
    await settle();
    expect(channel.current("m1")).toContain("✓ done");
    expect(channel.current(channel.order[1]!)).toContain("1 tool");
  });

  test("a view that can't be fetched is never re-sent; the reply still gets its count; ended counts persist too", async () => {
    const channel = new IdChannel(false);
    const { start } = processes(channel);
    const bot1 = start();
    event(bot1.rpc, "t3", { type: "tool_start", name: "bash", summary: "" });
    event(bot1.rpc, "t4", { type: "tool_start", name: "a", summary: "" });
    event(bot1.rpc, "t4", { type: "tool_start", name: "b", summary: "" });
    await settle();
    event(bot1.rpc, "t4", { type: "turn_end", aborted: false });
    await settle();
    const before = channel.order.length;

    const bot2 = start();
    bot2.rpc.handler!.onRegister!({ ...CONN, state: "idle" });
    await settle();
    expect(channel.order).toHaveLength(before);
    await bot2.link.deliver(deliverParams({ outboxId: "r3", turnId: "t3", text: "x" }));
    await bot2.link.deliver(deliverParams({ outboxId: "r4", turnId: "t4", text: "y" }));
    expect(channel.current(channel.order.at(-2)!)).toContain("1 tool");
    expect(channel.current(channel.order.at(-1)!)).toContain("2 tools");
  });

  test("a new main turn finalizes a restored view of an earlier turn", async () => {
    const channel = new IdChannel();
    const { start } = processes(channel);
    const bot1 = start();
    event(bot1.rpc, "t5", { type: "tool_start", name: "bash", summary: "" });
    await settle();
    const bot2 = start();
    bot2.rpc.handler!.onRegister!({ ...CONN, state: "streaming" });
    event(bot2.rpc, "t6", { type: "turn_start" });
    await settle();
    expect(bot2.link.hasTurn("t5")).toBe(false);
    expect(channel.current("m1")).toContain("⚠️ interrupted");
  });
});

describe("subagent chat/events", () => {
  function sub(rpc: FakeRpc, turnId: string, ev: ChatEventPayload, agentId = "01JRUNID"): void {
    rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { principalId: P, turnId, agentId, parentRunId: "main", ev });
  }

  test("the contract accepts a runId agentId", () => {
    expect(chatEventParams.safeParse({ principalId: P, turnId: "t", agentId: "01JRUNID", ev: { type: "turn_start" } }).success).toBe(true);
    expect(chatEventParams.safeParse({ principalId: P, turnId: "t", agentId: "", ev: { type: "turn_start" } }).success).toBe(false);
  });

  test("subagent tools nest under the parent turn; its turn events never end the parent", async () => {
    const { link, rpc, channel, timers } = setup();
    event(rpc, "t1", { type: "tool_start", name: "task", summary: "delegate" });
    await tick();
    sub(rpc, "t1", { type: "turn_start" });
    sub(rpc, "t1", { type: "tool_start", name: "task", summary: "inner" });
    sub(rpc, "t1", { type: "tool_end", name: "task", ok: true });
    sub(rpc, "t1", { type: "turn_end", aborted: false });
    expect(link.hasTurn("t1")).toBe(true);
    timers.fireAll();
    await settle();
    const working = textOf(channel.edits[0]!.at(-1)!);
    expect(working).toContain("… `task` delegate");
    expect(working).toContain("↳ ✓ `task` inner");
    event(rpc, "t1", { type: "turn_end", aborted: false });
    await settle();
    expect(textOf(channel.edits[0]!.at(-1)!)).toContain("2 tools");
    expect(channel.sent).toHaveLength(1);
  });

  test("a subagent event without a live parent turn is ignored, not a new message", async () => {
    const { link, rpc, channel } = setup();
    sub(rpc, "nope", { type: "tool_start", name: "bash", summary: "" });
    sub(rpc, "nope", { type: "turn_end", aborted: true });
    await settle();
    expect(channel.sent).toHaveLength(0);
    expect(link.hasTurn("nope")).toBe(false);
  });
});

describe("workspace flag off", () => {
  test("the link drains deliveries but offers and serves no tools", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const rpc = new FakeRpc([]);
    const channel = new FakeChannel([]);
    const calls: string[] = [];
    const link = new WorkspaceLink({
      principalId: P,
      store: new WorkspaceLinkStore(db),
      surfaces: discordSurfaces(async () => channel),
      owner: () => ({ id: "owner-1", name: "drk" }),
      enabled: false,
      tools: {
        manifest: () => [{ name: "web_search", description: "d", inputSchema: { type: "object" }, approval: "none" }],
        handleCall: async () => (calls.push("call"), { ok: true, result: "r" }),
        onSocketClosed: () => {},
      },
    });
    link.attach(rpc);
    expect(rpc.handler!.toolManifest!(CONN)).toEqual([]);
    await expect(rpc.handler!.onRequest!(CONN, RPC_METHODS.toolCall, { name: "web_search" })).rejects.toThrow("method not found");
    expect(calls).toEqual([]);
    await deliverViaServer(rpc, deliverParams({ outboxId: "left-over" }));
    await settle();
    expect(channel.sent).toHaveLength(1);
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck]);
  });
});

describe("plain-text fallback", () => {
  test("pages already sent as components aren't repeated in the fallback", async () => {
    const { link, rpc, channel } = setup();
    const text = Array.from({ length: 3 }, (_, i) => `section ${i}\n${"x".repeat(3000)}`).join("\n\n");
    let firstPageSent = false;
    channel.failWhen = (o) => {
      if (o.content !== undefined) return false;
      if (!firstPageSent) return !(firstPageSent = true);
      return true;
    };
    for (let i = 0; i < DELIVERY_MAX_FAILURES; i++) await link.deliver(deliverParams({ text }));
    const components = channel.sent.filter((m) => m.content === undefined);
    const plain = channel.sent.filter((m) => m.content !== undefined).map((m) => m.content).join("");
    expect(components).toHaveLength(1);
    expect(textOf(components[0]!)).toContain("section 0");
    expect(plain).not.toContain("section 0");
    expect(plain).toContain("section 2");
    expect(plain.length).toBeLessThan(text.length - 2000);
    expect(rpc.calls.map((c) => c.method)).toEqual([RPC_METHODS.chatAck]);
  });
});
