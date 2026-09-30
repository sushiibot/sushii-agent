import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import type { ChatHistoryResult, ChatMessageParams, ChatMessageResult } from "../../orchestration/contracts.ts";
import { RpcErrorReply } from "../../orchestration/transport/server.ts";
import type { SurfaceActor } from "../../orchestration/workspace/surface.ts";
import { isVerifiedWebActor, mintWebActor } from "./actor.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { createChatRoutes, type ChatRouteLink } from "./chatRoutes.ts";
import type { HistoryResponse } from "./events.ts";
import { WebInboundStore } from "./inbound.ts";
import { createPeerMatcher } from "./peers.ts";
import { createPresence } from "./presence.ts";
import { createWebHandler, type WebHandler } from "./server.ts";
import { WebWorkspaceAdapter, type WebUploadPort } from "./workspaceAdapter.ts";

const OWNER = "owner@example.com";
const GW = "172.31.250.1";
const CLIENT = "01J9Z3W8K2M4N6P8Q0R2S4T6V8";
const CLIENT2 = "01J9Z3W8K2M4N6P8Q0R2S4T6V9";
const PHOTO = "P".repeat(22);

/** The link as the routes see it: records calls, remembers message ids like the workspace does. */
class FakeLink {
  connected = true;
  sent: Array<Omit<ChatMessageParams, "principalId">> = [];
  seen = new Set<string>();
  ownerChecks: SurfaceActor[] = [];
  /** When set, sendMessage waits for it (a message still being routed). */
  hold: Promise<void> | null = null;
  history: ((q: { before?: string; limit: number }) => Promise<ChatHistoryResult>) | null = null;
  answered: Array<{ askId: string; choice: unknown; actor: SurfaceActor }> = [];

  isConnected = () => this.connected;
  sendMessage = async (i: Omit<ChatMessageParams, "principalId">): Promise<ChatMessageResult> => {
    this.sent.push(i);
    if (this.hold) await this.hold;
    const dup = this.seen.has(i.messageId);
    this.seen.add(i.messageId);
    return { accepted: true, mode: dup ? "duplicate" : "prompt" };
  };
  abort = async () => ({ aborted: true });
  newSession = async () => ({ sessionFile: "s" });
  recordOffline = () => {};
  interceptReply = async () => ({ handled: false as const });
  isOwner = (a: SurfaceActor) => {
    this.ownerChecks.push(a);
    return isVerifiedWebActor(a);
  };
  isLoginPending = () => false;
  startLogin = async () => ({ status: "started" as const });
  completeLogin = async () => ({ status: "ok" as const });
  cancelLogin = async () => ({ status: "cancelled" as const });
  command = async () => ({ text: "compacted" });
  stopTurn = async () => ({ status: "ok" as const, aborted: true, final: null });
  answerAsk = async (_o: unknown, askId: string, choice: unknown, actor: SurfaceActor) => {
    this.answered.push({ askId, choice, actor });
    return { status: "answered" as const, answer: "yes" };
  };
  chatHistory = async (q: { before?: string; limit: number }) => {
    if (!this.history) throw new RpcErrorReply("method not found: chat/history", -32601);
    return this.history(q);
  };
}

function webConfig(): WebConfig {
  return { port: 0, bindAddr: "127.0.0.1", ownerLogin: OWNER, distDir: "/nonexistent", devLogin: undefined, trustedPeers: [GW], push: undefined };
}

function setup(opts: { db?: Database; link?: FakeLink; uploads?: WebUploadPort } = {}) {
  const db = opts.db ?? new Database(":memory:");
  if (!opts.db) applySchema(db);
  const log = new SqliteChatLog(db);
  const inbound = new WebInboundStore(db);
  const presence = createPresence({ head: () => log.head() });
  const adapter = new WebWorkspaceAdapter({ log, inbound, presence, ...(opts.uploads ? { uploads: opts.uploads } : {}) });
  const link = opts.link ?? new FakeLink();
  const decisions: Array<{ nonce: string; decision: string; actor: SurfaceActor }> = [];
  const tools = {
    decide: (nonce: string, decision: "approve" | "deny", actor: SurfaceActor) => {
      decisions.push({ nonce, decision, actor });
      return isVerifiedWebActor(actor) ? ("decided" as const) : ("forbidden" as const);
    },
  };
  const routes = createChatRoutes({
    log,
    inbound,
    adapter,
    presence,
    link: link as unknown as ChatRouteLink,
    tools,
    workspaceEnabled: true,
    ...(opts.uploads ? { uploads: opts.uploads } : {}),
    sse: { heartbeatMs: 20, maxLifetimeMs: 5_000 },
  });
  const config = webConfig();
  const handler = createWebHandler({ config, peers: createPeerMatcher(config.trustedPeers), chat: routes });
  return { db, log, inbound, adapter, link, routes, handler, decisions };
}

function call(handler: WebHandler, path: string, init: { method?: string; body?: unknown; raw?: string; site?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ "Tailscale-User-Login": OWNER, ...init.headers });
  if (init.site !== null) headers.set("Sec-Fetch-Site", init.site ?? "same-origin");
  const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return handler(new Request(`http://agent.example${path}`, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body }), GW);
}

const post = (h: WebHandler, path: string, body: unknown, site?: string | null) => call(h, path, { body, ...(site !== undefined ? { site } : {}) });

/** Reads SSE frames until `count` have arrived, then cancels the stream. */
async function readFrames(res: Response, count: number, timeoutMs = 2000): Promise<Array<{ id?: string; event: string; data: unknown }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ id?: string; event: string; data: unknown }> = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!next || next.done) break;
    buf += decoder.decode(next.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (block.startsWith(":")) continue;
      const f: { id?: string; event: string; data: unknown } = { event: "", data: null };
      for (const line of block.split("\n")) {
        const [k, ...rest] = line.split(": ");
        const v = rest.join(": ");
        if (k === "id") f.id = v;
        else if (k === "event") f.event = v;
        else if (k === "data") f.data = JSON.parse(v);
      }
      frames.push(f);
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

const userEvents = (log: SqliteChatLog) => log.list(["user"]);

describe("POST /api/chat/messages", () => {
  test("persists before the 202, then routes with the minted actor by reference", async () => {
    const h = setup();
    const res = await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hello" });
    expect(res.status).toBe(202);
    const { seq } = (await res.json()) as { seq: number };
    expect(userEvents(h.log).map((e) => e.seq)).toEqual([seq]);
    await h.routes.idle();
    expect(h.link.sent).toEqual([expect.objectContaining({ messageId: CLIENT, text: "hello", origin: { surface: "web", conversationId: "main" }, kind: "user" })]);
    expect(isVerifiedWebActor(h.link.ownerChecks[0]!)).toBe(true);
    expect(h.inbound.get(CLIENT)!.routedAt).not.toBeNull();
    expect(h.log.list(["status"]).map((e) => e.data)).toEqual([{ clientId: CLIENT, state: "accepted" }]);
  });

  test("a duplicate POST returns the same seq and never routes twice", async () => {
    const h = setup();
    let release!: () => void;
    h.link.hold = new Promise((r) => (release = r));
    const a = (await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()) as { seq: number };
    // Still routing: a resend must not start a second route.
    const b = (await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()) as { seq: number };
    release();
    await h.routes.idle();
    // Routed: a resend is a no-op.
    const c = (await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()) as { seq: number };
    await h.routes.idle();
    expect([b.seq, c.seq]).toEqual([a.seq, a.seq]);
    expect(h.link.sent).toHaveLength(1);
    expect(userEvents(h.log)).toHaveLength(1);
  });

  test("offline: nothing is routed, and a resend of the same clientId is routed once back online", async () => {
    const h = setup();
    h.link.connected = false;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    expect(h.link.sent).toHaveLength(0);
    expect(h.log.list(["notice"]).map((e) => e.data)).toEqual([{ type: "workspaceOffline" }]);
    expect(h.inbound.get(CLIENT)!.routedAt).toBeNull();

    h.link.connected = true;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(h.inbound.get(CLIENT)!.routedAt).not.toBeNull();
    expect(userEvents(h.log)).toHaveLength(1);
  });

  test("a bot restart after the 202: the resend is routed once, with no second user event", async () => {
    const link = new FakeLink();
    const first = setup({ link });
    link.hold = new Promise(() => {}); // the process dies mid-route: the workspace took it, no receipt came back
    const a = (await (await post(first.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()) as { seq: number };
    link.hold = null;

    const second = setup({ db: first.db, link });
    const b = (await (await post(second.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()) as { seq: number };
    await second.routes.idle();
    expect(b.seq).toBe(a.seq);
    expect(userEvents(second.log)).toHaveLength(1);
    // The workspace answered duplicate; that still counts as the receipt the client waits for.
    expect(second.log.list(["status"]).map((e) => e.data)).toEqual([{ clientId: CLIENT, state: "accepted" }]);
    expect(second.inbound.get(CLIENT)!.routedAt).not.toBeNull();
  });

  test("validates the body: ids, caps and uploads", async () => {
    const h = setup();
    expect((await post(h.handler, "/api/chat/messages", { clientId: "nope", text: "x" })).status).toBe(400);
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "  " })).status).toBe(400);
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "x", extra: 1 })).status).toBe(400);
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "x", uploadIds: [PHOTO] })).status).toBe(400);
    // 16k three-byte chars is ~48 KB, within the 64 KiB message cap; the 8 KiB cap still holds elsewhere.
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT2, text: "€".repeat(16_000) })).status).toBe(202);
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "x".repeat(16_001) })).status).toBe(400);
    expect((await call(h.handler, "/api/chat/messages", { raw: JSON.stringify({ clientId: CLIENT, text: "x", pad: "y".repeat(70_000) }) })).status).toBe(413);
    expect((await call(h.handler, "/api/chat/seen", { raw: JSON.stringify({ seq: 1, pad: "y".repeat(9_000) }) })).status).toBe(413);
    const form = await h.handler(
      new Request("http://agent.example/api/chat/messages", { method: "POST", headers: { "Tailscale-User-Login": OWNER, "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" }, body: "{}" }),
      GW,
    );
    expect(form.status).toBe(415);
  });

  test("uploads must be known, and are marked referenced with the persisted message", async () => {
    const referenced: Array<{ ids: string[]; clientId: string }> = [];
    const uploads: WebUploadPort = {
      lookup: (ids) => new Map(ids.filter((id) => id === PHOTO).map((id) => [id, { id, contentType: "image/jpeg", bytes: 3, name: "p.jpg", inline: true }])),
      forOutbox: () => new Map(),
      storeDelivery: async () => ({ files: [], dropped: 0 }),
      markReferenced: (ids, clientId) => referenced.push({ ids, clientId }),
    };
    const h = setup({ uploads });
    h.link.connected = false;
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "", uploadIds: ["Q".repeat(22)] })).status).toBe(400);
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "", uploadIds: [PHOTO, PHOTO] })).status).toBe(202);
    await h.routes.idle();
    expect(referenced).toEqual([{ ids: [PHOTO], clientId: CLIENT }]);
    h.link.connected = true;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "", uploadIds: [PHOTO] });
    await h.routes.idle();
    expect(h.link.sent[0]!.attachments).toEqual([{ url: `upload:${PHOTO}`, name: "p.jpg", contentType: "image/jpeg" }]);
  });
});

describe("Fetch Metadata", () => {
  test("a GET with a cross-site or user-initiated header is refused; writes must be same-origin", async () => {
    const h = setup();
    h.link.history = async () => ({ items: [], before: null });
    expect((await call(h.handler, "/api/chat/history", { site: "cross-site" })).status).toBe(403);
    expect((await call(h.handler, "/api/chat/history", { site: "none" })).status).toBe(403);
    expect((await call(h.handler, "/api/me", { site: "same-site" })).status).toBe(403);
    expect((await call(h.handler, "/api/chat/history", { site: null })).status).toBe(200);
    expect((await post(h.handler, "/api/chat/seen", { seq: 0 }, "cross-site")).status).toBe(403);
  });

  test("a stream needs the header, and same-origin", async () => {
    const h = setup();
    expect((await call(h.handler, "/api/chat/stream", { site: null })).status).toBe(403);
    expect((await call(h.handler, "/api/chat/stream", { site: "same-site" })).status).toBe(403);
  });
});

describe("GET /api/chat/stream", () => {
  test("hello first, then the replay after the cursor, then live events, each once", async () => {
    const h = setup();
    const s1 = h.log.append("notice", { type: "nothingToStop" });
    const s2 = h.log.append("notice", { type: "loginUsage" });
    const res = await call(h.handler, `/api/chat/stream?after=${s1}`);
    expect(res.headers.get("Content-Type")).toStartWith("text/event-stream");
    setTimeout(() => h.log.append("session", { kind: "new" }), 10);
    const frames = await readFrames(res, 3);
    expect(frames[0]).toEqual({ event: "hello", data: { headSeq: s2, workspace: "online", openTurns: [] } });
    expect(frames.slice(1).map((f) => [f.id, f.event])).toEqual([
      [String(s2), "notice"],
      [String(s2 + 1), "session"],
    ]);
  });

  test("Last-Event-ID resumes; a cursor past head resets", async () => {
    const h = setup();
    const s1 = h.log.append("notice", { type: "nothingToStop" });
    h.log.append("notice", { type: "loginUsage" });
    const resumed = await readFrames(await call(h.handler, "/api/chat/stream", { headers: { "Last-Event-ID": String(s1) } }), 2);
    expect(resumed.map((f) => f.event)).toEqual(["hello", "notice"]);
    const reset = await readFrames(await call(h.handler, "/api/chat/stream?after=999"), 2);
    expect(reset.map((f) => f.event)).toEqual(["reset", "workspace"]);
    expect((await call(h.handler, "/api/chat/stream?after=abc")).status).toBe(400);
  });

  test("heartbeats keep a quiet stream alive, closeStreams ends it, and the subscription is released", async () => {
    const h = setup();
    const res = await call(h.handler, "/api/chat/stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(": hb")) text += decoder.decode((await reader.read()).value);
    expect(h.log.subscribers).toBe(1);
    h.routes.closeStreams();
    for (;;) if ((await reader.read()).done) break;
    expect(h.log.subscribers).toBe(0);
  });
});

describe("approvals and asks", () => {
  const NONCE = "abcdefghijklmnop";

  test("only a nonce the bot posted can be decided, with the minted actor", async () => {
    const h = setup();
    expect((await post(h.handler, `/api/chat/approvals/${NONCE}`, { decision: "approve" })).status).toBe(404);
    expect(h.decisions).toHaveLength(0);
    await h.adapter.approvalPrompt(null, { tool: "file_linear_issue", agentId: "main", agentName: "Main", fields: [] }, NONCE);
    const res = await post(h.handler, `/api/chat/approvals/${NONCE}`, { decision: "approve" });
    expect(await res.json()).toEqual({ status: "decided" });
    expect(isVerifiedWebActor(h.decisions[0]!.actor)).toBe(true);
    expect((await post(h.handler, `/api/chat/approvals/${NONCE}`, { decision: "maybe" })).status).toBe(400);
  });

  test("a look-alike actor is refused on every owner action", async () => {
    const h = setup();
    await h.adapter.approvalPrompt(null, { tool: "t", agentId: "main", agentName: "Main", fields: [] }, NONCE);
    const fake: SurfaceActor = { ...mintWebActor(OWNER) };
    const req = (path: string, body: unknown) =>
      h.routes.handle(new Request(`http://x${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), path, fake) as Promise<Response>;
    expect((await req(`/api/chat/approvals/${NONCE}`, { decision: "approve" })).status).toBe(403);
    expect((await req("/api/chat/stop", {})).status).toBe(403);
    expect((await req("/api/chat/command", { command: "new" })).status).toBe(403);
  });

  test("an ask is answered only if the bot posted it, and its answer is recorded", async () => {
    const h = setup();
    expect((await post(h.handler, "/api/chat/asks/q1", { index: 0, label: "x" })).status).toBe(404);
    await h.adapter.askPrompt(null, { askId: "q1", question: "Which?", choices: ["red", "blue"] }, { ledger: { isSent: () => false, markSent: () => {} }, plain: false, outboxId: "o1" });
    const res = await post(h.handler, "/api/chat/asks/q1", { index: 1, label: "spoofed" });
    expect(await res.json()).toEqual({ status: "answered" });
    expect(h.link.answered[0]!.choice).toEqual({ index: 1, label: "blue" });
    expect(isVerifiedWebActor(h.link.answered[0]!.actor)).toBe(true);
    expect(h.log.list(["ask_resolved"]).map((e) => e.data)).toEqual([{ askId: "q1", answer: "yes" }]);
  });
});

describe("GET /api/chat/history", () => {
  test("503 when the workspace is down, 501 when it lacks the RPC", async () => {
    const h = setup();
    h.link.connected = false;
    expect(await (await call(h.handler, "/api/chat/history")).json()).toEqual({ offline: true });
    h.link.connected = true;
    const res = await call(h.handler, "/api/chat/history");
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ unsupported: true });
    h.link.history = async () => {
      throw new RpcErrorReply("unknown history cursor", -32000);
    };
    const stale = await call(h.handler, "/api/chat/history?before=gone:1");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ reset: true });
  });

  test("items matching the bot's record render from it and are verified; the rest are not", async () => {
    const h = setup();
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "bot copy" });
    await h.routes.idle();
    const ledger = { isSent: () => false, markSent: () => {} };
    await h.adapter.sendReply(null, { kind: "reply", text: "bot reply", toolCount: null }, { ledger, plain: false, outboxId: "o1" });
    await h.adapter.approvalPrompt(null, { tool: "t", agentId: "main", agentName: "Main", fields: [] }, "abcdefghijklmnop");
    const later = new Date(Date.now() + 60_000).toISOString();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    h.link.history = async () => ({
      items: [
        { type: "user", id: "u0", at: earlier, text: "tampered", clientId: "01J9Z3W8K2M4N6P8Q0R2S4T6VA", attachments: [] },
        { type: "user", id: "u1", at: earlier, text: "workspace copy", clientId: CLIENT, attachments: [] },
        { type: "assistant", id: "a1", at: later, text: "workspace reply", outboxId: "o1", tools: [] },
        { type: "assistant", id: "a2", at: later, text: "old reply", tools: [] },
      ],
      before: "cursor-1",
    });
    const page = (await (await call(h.handler, "/api/chat/history?limit=10")).json()) as HistoryResponse;
    expect(page.before).toBe("cursor-1");
    expect(page.items.map((i) => [i.type, "verified" in i ? i.verified : null, "text" in i ? i.text : null])).toEqual([
      ["user", false, "tampered"],
      ["user", true, "bot copy"],
      ["approval", null, null],
      ["assistant", true, "bot reply"],
      ["assistant", false, "old reply"],
    ]);
  });
});

describe("history approvals across pages", () => {
  test("an approval between two pages lands on exactly one of them", async () => {
    const h = setup();
    await h.adapter.approvalPrompt(null, { tool: "t", agentId: "main", agentName: "Main", fields: [] }, "abcdefghijklmnop");
    const approvedAt = h.log.list(["approval"])[0]!.createdAt;
    const at = (d: number) => new Date(approvedAt + d).toISOString();
    const older = { type: "user" as const, id: "s:1", at: at(-1000), text: "before", attachments: [] };
    const newer = { type: "assistant" as const, id: "s:2", at: at(1000), text: "after", tools: [] };
    h.link.history = async (q) => (q.before ? { items: [older], before: null } : { items: [newer], before: "s:2" });
    const head = (await (await call(h.handler, "/api/chat/history")).json()) as HistoryResponse;
    const next = (await (await call(h.handler, "/api/chat/history?before=s:2")).json()) as HistoryResponse;
    expect(head.items.map((i) => i.type)).toEqual(["approval", "assistant"]);
    expect(next.items.map((i) => i.type)).toEqual(["user"]);
  });
});

describe("stop and commands", () => {
  test("stop without a turn aborts; commands answer on the log", async () => {
    const h = setup();
    expect((await post(h.handler, "/api/chat/stop", {})).status).toBe(202);
    expect((await post(h.handler, "/api/chat/command", { command: "compact" })).status).toBe(202);
    await Bun.sleep(5);
    expect(h.log.list(["session"]).map((e) => e.data)).toEqual([{ kind: "compacted" }]);
    expect(h.log.list(["notice"]).map((e) => e.data)).toEqual([{ type: "commandResult", text: "compacted" }]);
    h.link.connected = false;
    await post(h.handler, "/api/chat/command", { command: "new" });
    await post(h.handler, "/api/chat/stop", { turnId: "t1" });
    await Bun.sleep(5);
    expect(h.log.list(["notice"]).slice(1).map((e) => e.data)).toEqual([{ type: "newWhileOffline" }, { type: "nothingToStop" }]);
  });
});

describe("seen receipts", () => {
  test("a seen receipt is 204", async () => {
    const h = setup();
    expect((await post(h.handler, "/api/chat/seen", { seq: 5 })).status).toBe(204);
    expect((await post(h.handler, "/api/chat/seen", { seq: -1 })).status).toBe(400);
  });
});

