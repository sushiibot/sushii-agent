import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { RPC_METHODS, type ChatDeliverParams, type ChatEventPayload } from "../../orchestration/contracts.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../../orchestration/transport/server.ts";
import { WorkspaceLink, type WorkspaceRpc } from "../../orchestration/workspace/link.ts";
import type { Timers } from "../../orchestration/workspace/progress.ts";
import { SurfaceRegistry, type ApprovalView } from "../../orchestration/workspace/surface.ts";
import { SqliteChatLog } from "./chatLog.ts";
import type { ChatEnvelope, UploadRef } from "./events.ts";
import { WebInboundStore } from "./inbound.ts";
import { createPresence } from "./presence.ts";
import { WebWorkspaceAdapter, type WebUploadPort } from "./workspaceAdapter.ts";

const P = "drk";
const CONN: ConnectionInfo = { runnerId: `workspace-${P}`, role: "workspace", principalId: P, protocolVersion: 1, state: "streaming" };
const WEB = { surface: "web", conversationId: "main" };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Timers that fire only when flushed. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  const timers: Timers = {
    set: (fn) => (pending.set(++id, fn), id),
    clear: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get size() {
      return pending.size;
    },
  };
}

class FakeRpc implements WorkspaceRpc {
  handler: WorkspaceHandler | null = null;
  calls: Array<{ method: string; params: unknown }> = [];
  onAck: (() => void) | null = null;
  getWorkspaceConnection(principalId: string): ConnectionInfo | undefined {
    return principalId === P ? CONN : undefined;
  }
  async requestWorkspace(_p: string, method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === RPC_METHODS.chatAck) this.onAck?.();
    return {};
  }
  setWorkspaceHandler(handler: WorkspaceHandler | null): void {
    this.handler = handler;
  }
}

function setup(opts: { sent?: number; uploads?: WebUploadPort; db?: Database } = {}) {
  const db = opts.db ?? new Database(":memory:");
  if (!opts.db) applySchema(db);
  const log = new SqliteChatLog(db);
  const t = manualTimers();
  const presence = createPresence({ head: () => log.head(), timers: t.timers, waitMs: 10 });
  const pushes: Array<{ tag?: string; body: string }> = [];
  const breakGlass: string[] = [];
  const adapter = new WebWorkspaceAdapter({
    log,
    inbound: new WebInboundStore(db),
    presence,
    push: { send: async (p) => (pushes.push(p), { sent: opts.sent ?? 1 }) },
    breakGlass: async (nonce) => (breakGlass.push(nonce), true),
    ...(opts.uploads ? { uploads: opts.uploads } : {}),
    timers: t.timers,
  });
  const surfaces = new SurfaceRegistry("web", { pinned: true }).register(adapter);
  const rpc = new FakeRpc();
  const link = new WorkspaceLink({ principalId: P, store: new WorkspaceLinkStore(db), surfaces, owner: () => ({ id: "", name: "drk" }), timers: t.timers });
  link.attach(rpc);
  const events: ChatEnvelope[] = [];
  log.subscribe(null, (ev) => events.push(ev));
  const event = (turnId: string, ev: ChatEventPayload) =>
    rpc.handler!.onNotification!(CONN, RPC_METHODS.chatEvent, { origin: WEB, principalId: P, turnId, agentId: "main", ev });
  return { db, log, adapter, link, rpc, events, pushes, breakGlass, presence, timers: t, event };
}

const deliver = (o: Partial<ChatDeliverParams> = {}): ChatDeliverParams => ({ outboxId: "o1", principalId: P, kind: "reply", text: "hello", origin: WEB, ...o });

describe("web adapter deliveries", () => {
  test("a reply is committed before the outbox is acked", async () => {
    const h = setup();
    let committedAtAck: unknown = null;
    h.rpc.onAck = () => (committedAtAck = h.log.find("reply", "o1")?.data.text ?? null);
    await h.link.deliver(deliver());
    expect(committedAtAck).toBe("hello");
    expect(h.events.filter((e) => e.type === "reply")).toHaveLength(1);
  });

  test("a resent delivery is stored once, even after the bot forgot it was seen", async () => {
    const h = setup();
    await h.link.deliver(deliver());
    // A crash after the commit but before the seen row: the next process has no seen record.
    h.db.run("DELETE FROM workspace_outbox_seen");
    await h.link.deliver(deliver());
    await h.link.deliver(deliver());
    expect(h.log.list(["reply"])).toHaveLength(1);
    expect(h.rpc.calls.filter((c) => c.method === RPC_METHODS.chatAck)).toHaveLength(3);
    expect(h.events.filter((e) => e.type === "reply")).toHaveLength(1);
  });

  test("a delivery for another web conversation is refused and left unacked", async () => {
    const h = setup();
    await h.link.deliver(deliver({ origin: { surface: "web", conversationId: "other" } }));
    expect(h.log.list(["reply"])).toHaveLength(0);
    expect(h.rpc.calls.filter((c) => c.method === RPC_METHODS.chatAck)).toHaveLength(0);
  });

  test("a Discord-origin delivery resolves to web", async () => {
    const h = setup();
    await h.link.deliver(deliver({ origin: { surface: "discord", conversationId: "dm" } }));
    expect(h.log.find("reply", "o1")).not.toBeNull();
  });

  test("files are stored as bot uploads; dropped ones, or all without a store, leave a note", async () => {
    const stored: Array<{ outboxId: string; names: string[] }> = [];
    const uploads: WebUploadPort = {
      storeDelivery: async (outboxId, files) => {
        stored.push({ outboxId, names: files.map((f) => f.name) });
        const ref: UploadRef = { id: "A".repeat(22), contentType: "image/png", bytes: 3, name: files[0]!.name, inline: true };
        return { files: [ref], dropped: files.length - 1 };
      },
      lookup: () => new Map(),
      forOutbox: () => new Map(),
      markReferenced: () => {},
    };
    const file = { name: "a.png", contentType: "image/png", dataBase64: Buffer.from("png").toString("base64") };
    const h = setup({ uploads });
    expect(h.adapter.capabilities.fileUploads).toBe(true);
    await h.link.deliver(deliver({ files: [file, { ...file, name: "b.png" }] }));
    expect(stored).toEqual([{ outboxId: "o1", names: ["a.png", "b.png"] }]);
    expect(h.log.find("reply", "o1")!.data).toMatchObject({ text: "hello\n\n[file dropped: quota]", files: [{ id: "A".repeat(22) }] });

    const bare = setup();
    expect(bare.adapter.capabilities.fileUploads).toBe(false);
    await bare.link.deliver(deliver({ files: [file] }));
    expect(bare.log.find("reply", "o1")!.data).toMatchObject({ text: "hello\n\n[file dropped: storage unavailable]", files: [] });
  });

  test("an ask and a sign-in link are stored with their outbox id", async () => {
    const h = setup();
    await h.link.deliver(deliver({ outboxId: "a1", kind: "ask", text: "", ask: { askId: "q1", question: "Which?", choices: ["x", " "] } }));
    await h.link.deliver(deliver({ outboxId: "l1", kind: "auth", text: "", auth: { url: "https://auth.example/x", instructions: "Open it" } }));
    expect(h.log.find("ask", "a1")!.data).toEqual({ key: "a1", askId: "q1", question: "Which?", choices: ["x", "(option 2)"] });
    expect(h.log.find("auth", "l1")!.data).toEqual({ key: "l1", url: "https://auth.example/x", instructions: "Open it" });
  });

  test("a non-https sign-in link never becomes an auth event", async () => {
    const h = setup();
    await h.adapter.authPrompt(null, { url: "javascript:alert(1)", instructions: "Open it" }, { ledger: { isSent: () => false, markSent: () => {} }, plain: false, outboxId: "l2" });
    expect(h.log.find("auth", "l2")).toBeNull();
    expect(h.log.find("proactive", "l2")!.data.text).toBe("Open it");
  });
});

describe("web adapter progress", () => {
  test("deltas carry running offsets from the adapter's own buffer", async () => {
    const h = setup();
    h.event("t1", { type: "text_delta", text: "Hel" });
    await tick();
    h.event("t1", { type: "text_delta", text: "lo" });
    h.event("t1", { type: "text_delta", text: "!" });
    await h.link.settled();
    const deltas = h.events.filter((e) => e.type === "delta").map((e) => e.data);
    expect(deltas).toEqual([
      { turnId: "t1", offset: 3, text: "lo" },
      { turnId: "t1", offset: 5, text: "!" },
    ]);
    expect(h.adapter.openTurns()[0]!.text).toBe("Hello!");
    const first = h.events.find((e) => e.type === "snapshot")!;
    expect(first.data).toMatchObject({ turnId: "t1", view: { text: "Hel" } });
  });

  test("tool lines stream as tool events, and the final state is durable", async () => {
    const h = setup();
    h.event("t1", { type: "tool_start", name: "bash", summary: "ls" });
    await h.link.settled();
    h.event("t1", { type: "tool_end", name: "bash", ok: true });
    await h.link.settled();
    h.event("t1", { type: "turn_end", aborted: false });
    await h.link.settled();
    expect(h.events.filter((e) => e.type === "tool").map((e) => e.data)).toEqual([
      { turnId: "t1", name: "bash", summary: "ls" },
      { turnId: "t1", name: "bash", summary: "ls", ok: true },
    ]);
    const final = h.events.find((e) => e.type === "turn_final")!;
    expect(final.seq).toBeNumber();
    expect(final.data).toMatchObject({ turnId: "t1", outcome: "done" });
    expect(h.adapter.openTurns()).toEqual([]);
  });

  test("snapshots are throttled while a turn runs", async () => {
    const h = setup();
    h.event("t1", { type: "text_delta", text: "a" });
    await tick();
    for (const c of "bcdef") h.event("t1", { type: "text_delta", text: c });
    await h.link.settled();
    expect(h.events.filter((e) => e.type === "snapshot")).toHaveLength(1);
    h.timers.flush();
    const snaps = h.events.filter((e) => e.type === "snapshot");
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.data).toMatchObject({ view: { text: "abcdef" } });
  });
});

describe("web adapter approvals and push", () => {
  const view: ApprovalView = { tool: "file_linear_issue", agentId: "main", agentName: "Main", fields: [], replyCode: "abc" };

  test("an approval is a durable event without a reply code, and resolves by nonce", async () => {
    const h = setup();
    await h.adapter.approvalPrompt(null, view, "n".repeat(16));
    expect(h.log.find("approval", "n".repeat(16))!.data.view).toEqual({ tool: "file_linear_issue", agentId: "main", agentName: "Main", fields: [] });
    await h.adapter.resolveApproval({ id: "x" }, view, "n".repeat(16), "approve");
    await h.adapter.resolveApproval({ id: "x" }, view, "n".repeat(16), "approve", { ok: true, result: "done" });
    await h.adapter.resolveApproval({ id: "y" }, view, "m".repeat(16), "expired");
    expect(h.log.list(["approval_resolved"]).map((e) => e.data)).toEqual([
      { nonce: "n".repeat(16), decision: "approve" },
      { nonce: "n".repeat(16), decision: "approve", result: { ok: true, result: "done" } },
      { nonce: "m".repeat(16), decision: "timeout" },
    ]);
  });

  test("a push that reaches no device breaks glass; a seen receipt suppresses the push", async () => {
    const h = setup({ sent: 0 });
    await h.adapter.approvalPrompt(null, view, "a".repeat(16));
    await tick();
    expect(h.pushes.map((p) => p.tag)).toEqual([`approval:${"a".repeat(16)}`]);
    expect(h.breakGlass).toEqual(["a".repeat(16)]);

    const close = h.presence.open("s1");
    await h.adapter.approvalPrompt(null, view, "b".repeat(16));
    h.presence.seen(h.log.head());
    await tick();
    expect(h.pushes).toHaveLength(1);
    expect(h.breakGlass).toHaveLength(1);
    close();
  });
});
