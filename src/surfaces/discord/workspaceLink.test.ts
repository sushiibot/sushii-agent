import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MessageCreateOptions, MessageEditOptions } from "discord.js";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { RPC_METHODS, type ChatDeliverParams, type ChatEventPayload } from "../../orchestration/contracts.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../../orchestration/transport/server.ts";
import { WorkspaceLink, answeredAsk, formatDuration, progressEditDelay, progressEditGap, type Timers, type WorkspaceRpc } from "./workspaceLink.ts";

const P = "drk";
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
  constructor(private readonly log: string[]) {}
  async send(options: MessageCreateOptions) {
    if (this.failNext) {
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
    ownerChannel: async () => channel,
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
    expect(progressEditDelay({ now: 1_000, startedAt: 0, lastEditAt: 0 })).toBe(2_000);
    expect(progressEditDelay({ now: 5_000, startedAt: 0, lastEditAt: 0 })).toBe(0);
    expect(progressEditDelay({ now: 45_000, startedAt: 0, lastEditAt: 40_000 })).toBe(5_000);
    expect(progressEditDelay({ now: 700_000, startedAt: 0, lastEditAt: 690_000 })).toBe(50_000);
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
    const [ask] = link.renderDelivery(deliverParams({ kind: "ask", ask: { askId: "a", question: "Merge now?", choices: ["Yes", "No"] } }));
    const edited = textOf(answeredAsk({ components: ask!.components as Array<{ toJSON(): unknown }> }, "Yes"));
    expect(edited).toContain("Merge now?");
    expect(edited).toContain("-# → Yes");
    expect(edited).not.toContain("wsask:");
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
    link.recordOffline("first q", "first a");
    link.recordOffline("second q", "second a");
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
    link.recordOffline("q1", "a1");
    link.recordOffline("q2", "a2");
    rpc.connected = true;
    rpc.respond = async () => {
      throw new Error("link closed");
    };
    await link.replayInbox();
    expect(rpc.calls).toHaveLength(1);
    expect(store.listInbox(P).map((r) => r.userText)).toEqual(["q1", "q2"]);
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
    expect(first).toContain("… **bash** rg -n WIKI");
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
    expect(edited).toContain("✓ **bash**");
    expect(edited).toContain("… **edit** vars.yml");

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
