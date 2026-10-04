import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "../../db/index.ts";
import { WorkspaceLinkStore } from "../../db/workspaceLink.ts";
import { RPC_METHODS, type ChatDeliverParams, type ChatEventPayload } from "../../orchestration/contracts.ts";
import type { ConnectionInfo, WorkspaceHandler } from "../../orchestration/transport/server.ts";
import { MAX_OPEN_TURNS, WorkspaceLink, type WorkspaceRpc } from "../../orchestration/workspace/link.ts";
import type { Timers } from "../../orchestration/workspace/progress.ts";
import { SurfaceRegistry, type ApprovalView, type InboundMessage } from "../../orchestration/workspace/surface.ts";
import { historyPage } from "./history.ts";
import { SqliteChatLog } from "./chatLog.ts";
import type { ChatEnvelope, UploadRef } from "./events.ts";
import { WebHomeStore } from "./homeStore.ts";
import { WebInboundStore } from "./inbound.ts";
import { SEEN_WAIT_MS, createPresence } from "./presence.ts";
import type { PushPayload } from "./push.ts";
import { REPLY_TEXT_MAX, TOOL_SUMMARY_MAX, TURN_TEXT_MAX, WebWorkspaceAdapter, type WebUploadPort } from "./workspaceAdapter.ts";

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

/** Timers on a fake clock: `advance` fires what falls due. */
function clockTimers() {
  let now = 0;
  let id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => (pending.set(++id, { at: now + ms, fn }), id),
    clear: (h) => void pending.delete(h as number),
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [k, t] of [...pending]) if (t.at <= now) (pending.delete(k), t.fn());
    },
  };
}

function setup(opts: { sent?: number; uploads?: WebUploadPort; db?: Database; appendBudget?: { burst: number; perSec: number }; presenceTimers?: Timers } = {}) {
  const db = opts.db ?? new Database(":memory:");
  if (!opts.db) applySchema(db);
  const log = new SqliteChatLog(db);
  const t = manualTimers();
  const presence = opts.presenceTimers ? createPresence({ head: () => log.head(), timers: opts.presenceTimers }) : createPresence({ head: () => log.head(), timers: t.timers, waitMs: 10 });
  const pushes: PushPayload[] = [];
  const breakGlass: string[] = [];
  const home = new WebHomeStore(db);
  const adapter = new WebWorkspaceAdapter({
    home,
    log,
    inbound: new WebInboundStore(db),
    presence,
    push: { send: async (p) => (pushes.push(p), { sent: opts.sent ?? 1 }) },
    breakGlass: async (nonce) => (breakGlass.push(nonce), true),
    ...(opts.uploads ? { uploads: opts.uploads } : {}),
    ...(opts.appendBudget ? { appendBudget: opts.appendBudget } : {}),
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
  return { db, log, home, adapter, link, rpc, events, pushes, breakGlass, presence, timers: t, event };
}

const deliver = (o: Partial<ChatDeliverParams> = {}): ChatDeliverParams => ({ outboxId: "o1", principalId: P, kind: "reply", text: "hello", origin: WEB, ...o });

describe("web adapter deliveries", () => {
  test("a job's message goes to the inbox, not the chat, once per outbox id", async () => {
    const h = setup();
    const job = { name: "heartbeat", runId: "01J0000000000000000000000A" };
    const msg = deliver({ origin: undefined, kind: "proactive", text: "Passport due Friday.", job });
    await h.link.deliver(msg);
    await h.link.deliver(msg);
    expect(h.log.find("proactive", "o1")).toBeNull();
    expect(h.home.messages()).toMatchObject([{ key: "o1", job: "heartbeat", runId: job.runId, text: "Passport due Friday.", read: false }]);
    expect(h.events.filter((e) => e.type === "inbox").map((e) => e.data)).toEqual([{ key: "o1" }]);
    await tick();
    expect(h.pushes).toEqual([{ title: "sushii-agent", body: "Passport due Friday.", url: "/inbox?item=msg%3Ao1", tag: "msg:o1" }]);
  });

  test("the last plain try of a job's message goes to the chat; a filed one isn't repeated there", async () => {
    const h = setup();
    const plain = { ledger: { isSent: () => false, markSent: () => {} }, plain: true };
    await h.adapter.sendReply(null, { kind: "proactive", text: "Heads up.", toolCount: null, job: { name: "heartbeat" } }, { ...plain, outboxId: "p1" });
    expect(h.log.find("proactive", "p1")?.data.text).toBe("Heads up.");
    h.home.addMessage({ key: "p2", job: "heartbeat", text: "Filed." });
    await h.adapter.sendReply(null, { kind: "proactive", text: "Filed.", toolCount: null, job: { name: "heartbeat" } }, { ...plain, outboxId: "p2" });
    expect(h.log.find("proactive", "p2")).toBeNull();
  });

  test("context boundaries persist once before acknowledgement and replay their snapshots through history", async () => {
    const h = setup();
    const boundary = { kind: "rotated" as const, summary: "## Next\nBook the hotel.", memory: { files: [{ path: "USER.md", content: "Likes tea.", change: "changed" as const, truncated: false }], truncated: false }, context: { files: [{ path: "USER.md", content: "Likes tea.", truncated: false }], truncated: false } };
    let storedAtAck = false;
    h.rpc.onAck = () => { storedAtAck = !!h.log.find("session", "boundary-1"); };
    const entry = deliver({ kind: "session", text: "", session: boundary, outboxId: "boundary-1" });
    await h.link.deliver(entry);
    expect(storedAtAck).toBe(true);
    await h.link.deliver(entry);
    // Also idempotent if the bot crashes after storage, before recording that it saw the outbox.
    await h.adapter.sessionChanged(null, boundary, { plain: false, ledger: { isSent: () => false, markSent: () => {} }, outboxId: "boundary-1" });
    expect(h.log.list(["session"])).toHaveLength(1);
    const page = historyPage(h.log, { limit: 100 }, { maxBytes: 1_000_000 });
    expect(page.items).toContainEqual(expect.objectContaining({ type: "divider", ...boundary }));
    expect(h.events.filter(e => e.type === "reply")).toHaveLength(0);
  });

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

  test("a delivery for another web conversation is refused once and acked, never stored or retried", async () => {
    const h = setup();
    await h.link.deliver(deliver({ origin: { surface: "web", conversationId: "other" } }));
    await h.link.deliver(deliver({ origin: { surface: "web", conversationId: "other" } }));
    expect(h.log.list(["reply"])).toHaveLength(0);
    expect(h.rpc.calls.filter((c) => c.method === RPC_METHODS.chatAck)).toHaveLength(2);
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
      markReferenced: () => ({ missing: [] }),
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

  test("a turn shows as working from its turn_start, and a silent one still gets its final", async () => {
    const h = setup();
    h.event("t1", { type: "turn_start" });
    await h.link.settled();
    expect(h.events.filter((e) => e.type === "snapshot").map((e) => e.data)).toEqual([
      { turnId: "t1", view: { turnId: "t1", startedAt: expect.any(Number), lines: [], toolCount: 0, text: "" } },
    ]);
    expect(h.adapter.openTurns().map((t) => t.turnId)).toEqual(["t1"]);
    h.event("t1", { type: "turn_end", aborted: false });
    await h.link.settled();
    await tick();
    expect(h.adapter.openTurns()).toEqual([]);
    expect(h.events.filter((e) => e.type === "turn_final").map((e) => e.data)).toMatchObject([{ turnId: "t1", outcome: "done" }]);
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
      { turnId: "t1", name: "bash", summary: "ls", id: "t1:0", textOffset: 0 },
      { turnId: "t1", name: "bash", summary: "ls", ok: true, id: "t1:0", textOffset: 0 },
    ]);
    const final = h.events.find((e) => e.type === "turn_final")!;
    expect(final.seq).toBeNumber();
    expect(final.data).toMatchObject({ turnId: "t1", outcome: "done" });
    expect(h.adapter.openTurns()).toEqual([]);
  });

  test("a turn finalized as interrupted after a restart is still marked done when its reply lands", async () => {
    const before = setup();
    before.event("t1", { type: "tool_start", name: "bash", summary: "ls" });
    await before.link.settled();
    await tick();

    const after = setup({ db: before.db });
    after.rpc.handler!.onRegister!({ ...CONN, state: "idle" });
    await after.link.settled();
    await after.link.deliver(deliver({ turnId: "t1" }));
    await tick();
    expect(after.log.list(["turn_final"]).map((e) => [e.key, e.data.outcome])).toEqual([
      ["t1:interrupted", "interrupted"],
      ["t1:done", "done"],
    ]);
  });

  test("reasoning status reaches live snapshots and reconnect views without changing progress after output", async () => {
    const h = setup();
    h.event("t1", { type: "turn_start" });
    await h.link.settled();
    expect(h.adapter.openTurns()[0]!.modelActivity).toBeUndefined();
    h.event("t1", { type: "model_activity", activity: "thinking" });
    await h.link.settled();
    h.timers.flush();
    expect(h.adapter.openTurns()[0]!.modelActivity).toBe("thinking");
    expect(h.events.filter((e) => e.type === "snapshot").at(-1)!.data).toMatchObject({ view: { modelActivity: "thinking", text: "" } });
    h.event("t1", { type: "model_activity", activity: "waiting" });
    await h.link.settled();
    h.timers.flush();
    expect(h.adapter.openTurns()[0]!.modelActivity).toBe("waiting");
    h.event("t1", { type: "text_delta", text: "reply" });
    h.event("t1", { type: "model_activity", activity: "thinking" });
    await h.link.settled();
    h.timers.flush();
    expect(h.adapter.openTurns()[0]!.modelActivity).toBe("waiting");
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

describe("web adapter push rules", () => {
  const view: ApprovalView = { tool: "file_linear_issue", agentId: "main", agentName: "Main", fields: [] };
  const attempt = (outboxId: string) => ({ ledger: { isSent: () => false, markSent: () => {} }, plain: false, outboxId });

  test("each durable event maps to its push; deltas, tools and non-interrupted finals never push", async () => {
    const h = setup();
    await h.adapter.approvalPrompt(null, view, "n".repeat(16));
    await h.adapter.askPrompt(null, { askId: "A", question: "Which **one**?", choices: ["x"] }, attempt("o1"));
    await h.adapter.authPrompt(null, { url: "https://example.com/login", instructions: "Sign in" }, attempt("o2"));
    await h.adapter.sendReply(null, { kind: "reply", text: `# Title\n${"word ".repeat(60)}`, toolCount: null }, attempt("o3"));
    await h.adapter.sendReply(null, { kind: "proactive", text: "Reminder", toolCount: null }, attempt("o4"));
    const handle = await h.adapter.progressCreate(null, { turnId: "t1", startedAt: 0, lines: [{ name: "bash", summary: "ls", state: "run" }], toolCount: 1, text: "" });
    await h.adapter.progressDelta(handle, "hi", { turnId: "t1", startedAt: 0, lines: [], toolCount: 1, text: "hi" });
    await h.adapter.progressFinalize(null, handle, { outcome: "done", summary: null });
    await h.adapter.progressFinalize(null, { id: "t2" }, { outcome: "stopped", summary: null });
    await h.adapter.progressFinalize(null, { id: "t3" }, { outcome: "interrupted", summary: null });
    await tick();
    expect(h.pushes.map((p) => [p.tag, p.url])).toEqual([
      [`approval:${"n".repeat(16)}`, `/?approve=${"n".repeat(16)}`],
      ["ask:A", "/?ask=A"],
      ["auth", "/chat"],
      ["chat", "/chat"],
      ["chat", "/chat"],
      ["chat", "/chat"],
    ]);
    expect(h.pushes[0]!.requireInteraction).toBe(true);
    expect(h.pushes[1]!.body).toBe("Which one?");
    expect(h.pushes[3]!.renotify).toBe(false);
    expect(h.pushes[3]!.body.startsWith("Title word")).toBe(true);
    expect(Array.from(h.pushes[3]!.body)).toHaveLength(140);
    expect(h.pushes[5]!.body).toBe("Turn interrupted");
    expect(h.pushes.some((p) => p.silent)).toBe(false);
  });

  test("an approval waits 8s for a seen receipt with a stream open, then pushes", async () => {
    const clock = clockTimers();
    const h = setup({ presenceTimers: clock.timers });
    const close = h.presence.open("s1");

    await h.adapter.approvalPrompt(null, view, "a".repeat(16));
    clock.advance(SEEN_WAIT_MS - 1);
    await tick();
    expect(h.pushes).toHaveLength(0);
    h.presence.seen(h.log.head());
    clock.advance(1);
    await tick();
    expect(h.pushes).toHaveLength(0);
    expect(h.breakGlass).toHaveLength(0);

    await h.adapter.approvalPrompt(null, view, "b".repeat(16));
    clock.advance(SEEN_WAIT_MS);
    await tick();
    expect(h.pushes.map((p) => p.tag)).toEqual([`approval:${"b".repeat(16)}`]);
    // A receipt after the window is too late to take the push back.
    h.presence.seen(h.log.head());
    await tick();
    expect(h.pushes).toHaveLength(1);
    close();
  });

  test("with no stream open an approval pushes at once", async () => {
    const clock = clockTimers();
    const h = setup({ presenceTimers: clock.timers });
    await h.adapter.approvalPrompt(null, view, "c".repeat(16));
    await tick();
    expect(h.pushes).toHaveLength(1);
  });

  test("an approval pushed to no device breaks glass; a suppressed one never does", async () => {
    const h = setup({ sent: 0 });
    await h.adapter.approvalPrompt(null, view, "d".repeat(16));
    await tick();
    expect(h.breakGlass).toEqual(["d".repeat(16)]);
  });

  test("the photo quota warning pushes as quota, and a newer seen receipt suppresses it", async () => {
    const clock = clockTimers();
    const h = setup({ presenceTimers: clock.timers });
    await h.adapter.sendReply(null, { kind: "reply", text: "earlier", toolCount: null }, attempt("o1"));
    await tick();
    // A receipt for what was already on screen does not cover a warning raised after it.
    h.presence.seen(h.log.head());
    await h.adapter.notifyPhotoQuota(80, 100);
    expect(h.pushes.map((p) => [p.tag, p.body, p.silent])).toEqual([
      ["chat", "earlier", undefined],
      ["quota", "80% of the photo quota is used.", undefined],
    ]);

    await h.adapter.notifyPhotoQuota(85, 100);
    expect(h.pushes.at(-1)).toMatchObject({ tag: "quota", body: "85% of the photo quota is used." });

    const close = h.presence.open("s1");
    const pending = h.adapter.notifyPhotoQuota(90, 100);
    await h.adapter.sendReply(null, { kind: "reply", text: "later", toolCount: null }, attempt("o2"));
    h.presence.seen(h.log.head());
    clock.advance(SEEN_WAIT_MS);
    await pending;
    await tick();
    expect(h.pushes.filter((p) => p.tag === "quota")).toHaveLength(2);
    close();
  });
});

describe("web adapter bounds on what the workspace sends", () => {
  const ledger = { isSent: () => false, markSent: () => {} };
  const acks = (h: ReturnType<typeof setup>) => h.rpc.calls.filter((c) => c.method === RPC_METHODS.chatAck).length;

  test("repeated turn_end for a turn never seen stores nothing; a real turn's final is keyed by its turnId", async () => {
    const h = setup();
    for (let i = 0; i < 200; i++) h.event("same", { type: "turn_end", aborted: true });
    h.event("t1", { type: "turn_start" });
    h.event("t1", { type: "turn_end", aborted: true });
    h.event("t1", { type: "turn_end", aborted: true });
    await h.link.settled();
    await tick();
    expect(h.log.list(["turn_final"]).map((e) => [e.key, e.data.turnId, e.data.outcome])).toEqual([["t1:stopped", "t1", "stopped"]]);
  });

  test("over the append budget a delivery stays unacked with no failure counted, and a final is dropped", async () => {
    const h = setup({ appendBudget: { burst: 2, perSec: 0 } });
    await h.link.deliver(deliver({ outboxId: "o1" }));
    await h.link.deliver(deliver({ outboxId: "o2" }));
    await h.link.deliver(deliver({ outboxId: "o3" }));
    expect(h.log.list(["reply"]).map((e) => e.key)).toEqual(["o1", "o2"]);
    expect(acks(h)).toBe(2);
    expect(h.db.query("SELECT count(*) AS n FROM kv WHERE key LIKE 'workspace:deliver_failures:%'").get()).toEqual({ n: 0 });
    // A resend of a stored delivery costs nothing and is still acked.
    h.db.run("DELETE FROM workspace_outbox_seen");
    await h.link.deliver(deliver({ outboxId: "o1" }));
    expect(acks(h)).toBe(3);
    await h.adapter.progressFinalize(null, { id: "t9" }, { outcome: "stopped", summary: null });
    expect(h.log.list(["turn_final"])).toHaveLength(0);
  });

  test("an oversized outbox id is refused and acked; long text is cut with a note", async () => {
    const h = setup();
    await h.link.deliver(deliver({ outboxId: "x".repeat(257) }));
    expect(h.log.list(["reply"])).toHaveLength(0);
    expect(acks(h)).toBe(1);
    await h.link.deliver(deliver({ outboxId: "o2", text: "a".repeat(REPLY_TEXT_MAX + 5), turnId: "t".repeat(257) }));
    const data = h.log.find("reply", "o2")!.data;
    expect(data.text).toBe(`${"a".repeat(REPLY_TEXT_MAX)}\n\n[truncated: 5 more characters]`);
    expect(data.turnId).toBeUndefined();
  });

  test("an ask reusing an earlier askId, or with an oversized one, is stored without answer buttons", async () => {
    const h = setup();
    await h.adapter.askPrompt(null, { askId: "A", question: "Delete prod?", choices: ["No", "Yes"] }, { ledger, plain: false, outboxId: "o1" });
    await h.adapter.askPrompt(null, { askId: "A", question: "Keep prod?", choices: ["Yes", "No"] }, { ledger, plain: false, outboxId: "o2" });
    await h.adapter.askPrompt(null, { askId: "A", question: "Delete prod?", choices: ["No", "Yes"] }, { ledger, plain: false, outboxId: "o1" });
    await h.adapter.askPrompt(null, { askId: "B".repeat(257), question: "Long?", choices: ["x"] }, { ledger, plain: false, outboxId: "o3" });
    expect(h.log.list(["ask"]).map((e) => [e.key, e.data.askId, e.data.choices])).toEqual([
      ["o1", "A", ["No", "Yes"]],
      ["o2", "", []],
      ["o3", "", []],
    ]);
    expect(h.log.findAsk("A")!.key).toBe("o1");
  });

  test("tool summaries and live text are capped", async () => {
    const h = setup();
    const handle = await h.adapter.progressCreate(null, { turnId: "t1", startedAt: 0, lines: [{ name: "bash", summary: "s".repeat(1000), state: "run" }], toolCount: 1, text: "" });
    const tool = h.events.find((e) => e.type === "tool")!.data as { summary: string };
    expect(tool.summary.startsWith("s".repeat(TOOL_SUMMARY_MAX))).toBe(true);
    expect(tool.summary.length).toBeLessThan(TOOL_SUMMARY_MAX + 40);
    const view = h.adapter.openTurns()[0]!;
    await h.adapter.progressDelta(handle, "x".repeat(TURN_TEXT_MAX - 1), view);
    await h.adapter.progressDelta(handle, "yz", view);
    await h.adapter.progressDelta(handle, "more", view);
    expect(h.adapter.openTurns()[0]!.text).toBe(`${"x".repeat(TURN_TEXT_MAX - 1)}y`);
    expect(h.events.filter((e) => e.type === "delta").map((e) => (e.data as { text: string }).text.length)).toEqual([TURN_TEXT_MAX - 1, 1]);
    h.adapter.close();
  });

  test("open turns are capped; the oldest is finalized as interrupted", async () => {
    const h = setup();
    for (let i = 0; i <= MAX_OPEN_TURNS; i++) await h.adapter.progressCreate(null, { turnId: `u${i}`, startedAt: 0, lines: [], toolCount: 0, text: "" });
    expect(h.adapter.openTurns().map((t) => t.turnId)).toHaveLength(MAX_OPEN_TURNS);
    expect(h.adapter.openTurns()[0]!.turnId).toBe("u1");
    expect(h.log.list(["turn_final"]).map((e) => e.key)).toEqual(["u0:interrupted"]);
    h.adapter.close();
  });

  test("a notice names the owner message it answers, except workspaceOffline, which asks for a resend", async () => {
    const h = setup();
    const message: InboundMessage = { origin: WEB, id: "01J9Z3W8K2M4N6P8Q0R2S4T6V8", text: "!login", author: { id: "o", name: "drk" }, isVoice: false, attachments: [] };
    await h.adapter.notice(message, { type: "loginUsage" });
    await h.adapter.notice(message, { type: "workspaceOffline" });
    expect(h.log.list(["notice"]).map((e) => e.data)).toEqual([{ type: "loginUsage", clientId: message.id }, { type: "workspaceOffline" }]);
  });

  test("messageRejected names its message but leaves it unrouted, so a retry re-drives it", async () => {
    const h = setup();
    const inbound = new WebInboundStore(h.db);
    const id = "01J9Z3W8K2M4N6P8Q0R2S4T6V9";
    inbound.insert({ clientId: id, text: "hi", uploadIds: [], seq: 1, createdAt: 0 });
    const message: InboundMessage = { origin: WEB, id, text: "hi", author: { id: "o", name: "drk" }, isVoice: false, attachments: [] };
    await h.adapter.notice(message, { type: "messageRejected", error: "boom" });
    expect(h.log.list(["notice"]).map((e) => e.data)).toEqual([{ type: "messageRejected", error: "boom", clientId: id }]);
    expect(inbound.get(id)!.routedAt).toBeNull();
    expect(inbound.get(id)!.state).toBe("rejected");
    inbound.markPending(id);
    await h.adapter.notice(message, { type: "loginUsage" });
    expect(inbound.get(id)!.state).toBe("routed");
  });
});


test("commentary and tool positions survive final delivery, history reload and pruning", async () => {
  const h = setup();
  h.event("ordered", { type: "turn_start" });
  await h.link.settled();
  h.event("ordered", { type: "text_delta", text: "Checking the config." });
  h.event("ordered", { type: "tool_start", name: "read", summary: "config.json" });
  await h.link.settled();
  h.event("ordered", { type: "tool_end", name: "read", ok: true });
  h.event("ordered", { type: "text_delta", text: "The config is valid." });
  await h.link.settled();
  h.event("ordered", { type: "turn_end", aborted: false });
  await h.link.settled();
  await h.adapter.sendReply(null, { kind: "reply", turnId: "ordered", text: "The config is valid.", toolCount: 1 }, { outboxId: "ordered-reply", ledger: { isSent: () => false, markSent: () => {} }, plain: false });
  h.log.prune(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const history = historyPage(h.log, { limit: 30 }, { maxBytes: 100_000 });
  expect(history.items).toMatchObject([{ type: "assistant", text: "The config is valid.", activityText: "Checking the config.The config is valid.", tools: [{ name: "read", textOffset: 20, ok: true }] }]);
});

describe("web adapter queue receipts", () => {
  test("an ack of queued leaves the row pending and still emits its status; every other ack routes it", async () => {
    const h = setup();
    const inbound = new WebInboundStore(h.db);
    inbound.insert({ clientId: "QUEUED1", text: "later", uploadIds: [], seq: 1, createdAt: Date.now() });
    const message: InboundMessage = { origin: WEB, id: "QUEUED1", text: "later", author: { id: "u", name: "drk" }, isVoice: false, attachments: [] };
    await h.adapter.ack(message, "queued");
    expect(inbound.get("QUEUED1")).toMatchObject({ state: "pending", routedAt: null });
    expect(h.log.list(["status"]).map((e) => e.data)).toEqual([{ clientId: "QUEUED1", state: "queued" }]);
    // Delivered at the turn's end: the receipt now marks it routed, as every other kind does.
    await h.adapter.ack(message, "accepted");
    expect(inbound.get("QUEUED1")).toMatchObject({ state: "routed", routedAt: expect.any(Number) });
    expect(h.log.list(["status"]).map((e) => e.data)).toEqual([
      { clientId: "QUEUED1", state: "queued" },
      { clientId: "QUEUED1", state: "accepted" },
    ]);
  });

  test("onTurnsIdle fires when the last open turn ends, and never while one is still open", async () => {
    const h = setup();
    let idle = 0;
    h.adapter.onTurnsIdle = () => void idle++;
    const view = (turnId: string) => ({ turnId, startedAt: 0, lines: [], toolCount: 0, text: "" });
    await h.adapter.progressCreate(null, view("t1"));
    await h.adapter.progressCreate(null, view("t2"));
    expect(h.adapter.openTurns()).toHaveLength(2);
    await h.adapter.progressFinalize(null, { id: "t1" }, { outcome: "done", summary: null });
    expect(idle).toBe(0);
    expect(h.adapter.openTurns()).toHaveLength(1);
    await h.adapter.progressFinalize(null, { id: "t2" }, { outcome: "done", summary: null });
    expect(idle).toBe(1);
    expect(h.adapter.openTurns()).toHaveLength(0);
    // A repeated final with nothing open still gives the queued rows their chance to drain.
    await h.adapter.progressFinalize(null, { id: "t2" }, { outcome: "done", summary: null });
    expect(idle).toBe(2);
  });
});


test("tool confirmation metadata survives RPC delivery, replay, pending state and history", async () => {
  const h = setup();
  const toolConfirmation = { tool: "bash", input: "bash: rm -rf build", reason: "recursive delete", toolCallId: "tc1" };
  await h.link.deliver(deliver({ outboxId: "confirm1", kind: "ask", text: "Allow?", ask: { askId: "q1", question: "Allow?", choices: ["Yes", "No"], toolConfirmation } }));
  expect(h.log.find("ask", "confirm1")!.data).toMatchObject({ toolConfirmation });
  expect(h.log.pending({ approvalsSince: 0, asks: 10 }).asks[0]).toMatchObject({ toolConfirmation });
  const history = historyPage(h.log, { limit: 10 }, { maxBytes: 100_000 });
  expect(history.items.find((item) => item.type === "ask")).toMatchObject({ toolConfirmation });
});
