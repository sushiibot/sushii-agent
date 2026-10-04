import { BrowserLocationRequests } from "../../orchestration/workspace/location.ts";
import type { ConnectionInfo } from "../../orchestration/transport/server.ts";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import type { ChatMessageParams, ChatMessageResult } from "../../orchestration/contracts.ts";
import { RpcErrorReply } from "../../orchestration/transport/server.ts";
import type { SurfaceActor } from "../../orchestration/workspace/surface.ts";
import { isVerifiedWebActor, mintWebActor } from "./actor.ts";
import { INBOUND_RETENTION_MS, SqliteChatLog } from "./chatLog.ts";
import { createChatRoutes, type ChatRouteLink } from "./chatRoutes.ts";
import type { HistoryResponse } from "./events.ts";
import { WebInboundStore } from "./inbound.ts";
import { png } from "./__fixtures__/images.ts";
import { DiskUploadStore } from "./uploads.ts";
import { createPeerMatcher } from "./peers.ts";
import { createPresence } from "./presence.ts";
import { createWebHandler, startWebServer, type WebHandler } from "./server.ts";
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
}

function webConfig(): WebConfig {
  return { port: 0, bindAddr: "127.0.0.1", ownerLogin: OWNER, distDir: "/nonexistent", devLogin: undefined, trustedPeers: [GW], push: undefined };
}

function setup(opts: { db?: Database; link?: FakeLink; uploads?: WebUploadPort; historyMaxBytes?: number; discardWaitMs?: number } = {}) {
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
  const location = new BrowserLocationRequests({ isOwner: (a) => link.isOwner(a), prompt: (v, n) => adapter.approvalPrompt(null, v, n), resolved: (h, v, n, d) => adapter.resolveApproval({ id: h.id ?? n }, v, n, d) });
  const routes = createChatRoutes({
    location,
    log,
    inbound,
    adapter,
    presence,
    link: link as unknown as ChatRouteLink,
    tools,
    workspaceEnabled: true,
    ...(opts.uploads ? { uploads: opts.uploads } : {}),
    ...(opts.historyMaxBytes ? { historyMaxBytes: opts.historyMaxBytes } : {}),
    ...(opts.discardWaitMs ? { discardWaitMs: opts.discardWaitMs } : {}),
    sse: { heartbeatMs: 20, maxLifetimeMs: 5_000 },
  });
  const config = webConfig();
  const handler = createWebHandler({ config, peers: createPeerMatcher(config.trustedPeers), chat: routes });
  return { db, log, inbound, adapter, link, routes, handler, decisions, location };
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
      storeDelivery: async () => ({ files: [], dropped: 0 }),
      markReferenced: (ids, clientId) => {
        const missing = ids.filter((id) => id !== PHOTO);
        if (!missing.length) referenced.push({ ids, clientId });
        return { missing };
      },
    };
    const h = setup({ uploads });
    h.link.connected = false;
    const gone = await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "", uploadIds: [PHOTO, "Q".repeat(22)] });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: "upload_missing", ids: ["Q".repeat(22)] });
    expect(h.inbound.get(CLIENT)).toBeNull();
    expect(h.log.list(["user"])).toHaveLength(0);
    expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "", uploadIds: [PHOTO, PHOTO] })).status).toBe(202);
    await h.routes.idle();
    expect(referenced).toEqual([{ ids: [PHOTO], clientId: CLIENT }]);
    h.link.connected = true;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "", uploadIds: [PHOTO] });
    await h.routes.idle();
    expect(h.link.sent[0]!.attachments).toEqual([{ url: `upload:${PHOTO}`, name: "p.jpg", contentType: "image/jpeg" }]);
  });

  test("with the disk store on the same database, a missing upload rolls back the message and the other photo's reference", async () => {
    const db = new Database(":memory:");
    applySchema(db);
    const root = mkdtempSync(join(tmpdir(), "chat-uploads-"));
    try {
      const store = new DiskUploadStore({ root, db, freeBytes: async () => 1024 ** 4 });
      const photo = await store.put({ bytes: png(4, 4), name: "p.png", direction: "in", clientKey: "k1" });
      const referencedAt = () => db.query<{ referenced_at: number | null }, [string]>("SELECT referenced_at FROM web_uploads WHERE id = ?").get(photo.id)!.referenced_at;
      const h = setup({ db, uploads: store });
      h.link.connected = false;

      const gone = await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "look", uploadIds: [photo.id, "Q".repeat(22)] });
      expect(gone.status).toBe(409);
      expect(await gone.json()).toEqual({ error: "upload_missing", ids: ["Q".repeat(22)] });
      expect(h.inbound.get(CLIENT)).toBeNull();
      expect(h.log.list(["user"])).toHaveLength(0);
      expect(referencedAt()).toBeNull();

      expect((await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "look", uploadIds: [photo.id] })).status).toBe(202);
      await h.routes.idle();
      expect(referencedAt()).not.toBeNull();
      expect(h.log.list(["user"])).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Fetch Metadata", () => {
  test("a GET with a cross-site or user-initiated header is refused; writes must be same-origin", async () => {
    const h = setup();
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
    expect(frames[0]).toEqual({ event: "hello", data: { headSeq: s2, workspace: "online", openTurns: [], pending: { approvals: [], asks: [] } } });
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

describe("stream over a real Bun server", () => {
  test("a client that disconnects releases its subscription", async () => {
    const h = setup();
    const server = await startWebServer({ ...webConfig(), trustedPeers: ["127.0.0.1"] }, h.db, { chat: h.routes });
    try {
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/chat/stream`, {
        headers: { "Tailscale-User-Login": OWNER, "Sec-Fetch-Site": "same-origin" },
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toStartWith("event: hello\n");
      expect(h.log.subscribers).toBe(1);
      ctrl.abort();
      for (let i = 0; i < 100 && h.log.subscribers > 0; i++) await Bun.sleep(10);
      expect(h.log.subscribers).toBe(0);
    } finally {
      h.routes.closeStreams();
      server.stop(true);
    }
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
    expect(h.link.answered[0]!.choice).toEqual({ text: "blue" });
    expect(isVerifiedWebActor(h.link.answered[0]!.actor)).toBe(true);
    expect(h.log.list(["ask_resolved"]).map((e) => e.data)).toEqual([{ askId: "q1", answer: "yes" }]);
  });
});

describe("GET /api/chat/history", () => {
  const ledger = { isSent: () => false, markSent: () => {} };
  const view = { tool: "t", agentId: "main", agentName: "Main", fields: [] };
  const get = async (h: ReturnType<typeof setup>, q = "") => {
    const res = await call(h.handler, `/api/chat/history${q}`);
    expect(res.status).toBe(200);
    return (await res.json()) as HistoryResponse;
  };

  test("reads the bot's own log, oldest first, with resolutions folded in, while the workspace is offline", async () => {
    const h = setup();
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    await h.adapter.sendReply(null, { kind: "reply", text: "hello", toolCount: null }, { ledger, plain: false, outboxId: "o1" });
    await h.adapter.approvalPrompt(null, view, "abcdefghijklmnop");
    h.log.append("approval_resolved", { nonce: "abcdefghijklmnop", decision: "approve" }, "abcdefghijklmnop");
    await h.adapter.askPrompt(null, { askId: "k1", question: "Which?", choices: ["A", "B"] }, { ledger, plain: false, outboxId: "o2" });
    h.log.append("ask_resolved", { askId: "k1", answer: "B" }, "k1");
    h.log.append("session", { kind: "new" });
    h.link.connected = false;
    const page = await get(h);
    expect(page.before).toBeNull();
    expect(page.items).toMatchObject([
      { type: "user", clientId: CLIENT, text: "hi", attachments: [] },
      { type: "assistant", outboxId: "o1", text: "hello", tools: [], files: [] },
      { type: "approval", nonce: "abcdefghijklmnop", decision: "approve" },
      { type: "ask", askId: "k1", question: "Which?", answer: "B" },
      { type: "divider", kind: "new" },
    ]);
    expect(page.items.some((i) => "verified" in i)).toBe(false);
  });

  test("pages by seq; the last page says there is nothing older", async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) await h.adapter.sendReply(null, { kind: "reply", text: `r${i}`, toolCount: null }, { ledger, plain: false, outboxId: `o${i}` });
    h.log.append("notice", { type: "nothingToStop" });
    const texts = (p: HistoryResponse) => p.items.map((i) => (i.type === "assistant" ? i.text : i.type));
    const first = await get(h, "?limit=2");
    expect(texts(first)).toEqual(["r3", "r4"]);
    const second = await get(h, `?limit=2&before=${first.before}`);
    expect(texts(second)).toEqual(["r1", "r2"]);
    const last = await get(h, `?limit=2&before=${second.before}`);
    expect(texts(last)).toEqual(["r0"]);
    expect(last.before).toBeNull();
    // Exactly `limit` left: still the last page.
    expect((await get(h, `?limit=1&before=${second.before}`)).before).toBeNull();
  });

  test("a page stays under the byte cap, and one item too big for it becomes a placeholder", async () => {
    const h = setup({ historyMaxBytes: 12 * 1024 });
    for (let i = 0; i < 4; i++) await h.adapter.sendReply(null, { kind: "reply", text: "é".repeat(2_000), toolCount: null }, { ledger, plain: false, outboxId: `o${i}` });
    await h.adapter.sendReply(null, { kind: "reply", text: "b".repeat(9 * 1024), toolCount: null }, { ledger, plain: false, outboxId: "big" });
    const head = await get(h, "?limit=40");
    expect(head.items).toMatchObject([
      { type: "assistant", outboxId: "o2" },
      { type: "assistant", outboxId: "o3" },
      { type: "assistant", text: "[This message is too large to show here.]", tools: [], files: [] },
    ]);
    expect(head.before).toBe(head.items[0]!.id);
    expect((await get(h, `?before=${head.before}`)).items).toHaveLength(2);
  });

  describe("a reply sorts where its turn started", () => {
    const user = (h: ReturnType<typeof setup>, key: string) => h.log.append("user", { key, text: key, uploadIds: [], at: "2026-09-30T00:00:00.000Z" }, key);
    const turn = (turnId: string) => ({ turnId, startedAt: 0, lines: [], toolCount: 0, text: "" });
    const reply = (h: ReturnType<typeof setup>, turnId: string, outboxId: string) =>
      h.adapter.sendReply(null, { kind: "reply", text: outboxId, turnId, toolCount: null }, { ledger, plain: false, outboxId });
    const label = (i: HistoryResponse["items"][number]) => (i.type === "user" ? i.text : i.type === "assistant" ? i.text : i.type);
    const walk = async (h: ReturnType<typeof setup>, limit: number) => {
      const pages: string[][] = [];
      let before: string | null = null;
      do {
        const page: HistoryResponse = await get(h, `?limit=${limit}${before ? `&before=${before}` : ""}`);
        pages.unshift(page.items.map(label));
        before = page.before;
      } while (before !== null && pages.length < 20);
      return pages.flat();
    };

    /** U1 starts turn t1; U2 is steered in while t1 streams, and its answer runs as turn t2. */
    async function steered(h: ReturnType<typeof setup>) {
      user(h, "U1");
      h.log.append("status", { clientId: "U1", state: "accepted" });
      await h.adapter.progressCreate(null, turn("t1"));
      user(h, "U2");
      h.log.append("status", { clientId: "U2", state: "steer" });
      await h.adapter.progressFinalize(null, { id: "t1" }, { outcome: "done", summary: null });
      await h.adapter.progressCreate(null, turn("t2"));
      return h;
    }

    test("the answer before a steer comes before the steered message, as it did live", async () => {
      const h = await steered(setup());
      await reply(h, "t1", "R1");
      // Asked during t2, so it sits below t2's bubble, where the reply lands.
      await h.adapter.askPrompt(null, { askId: "k1", question: "Which?", choices: ["A"] }, { ledger, plain: false, outboxId: "ask" });
      await reply(h, "t2", "R2");
      await h.adapter.sendReply(null, { kind: "proactive", text: "P", toolCount: null }, { ledger, plain: false, outboxId: "P" });
      expect((await get(h)).items.map(label)).toEqual(["U1", "R1", "U2", "R2", "ask", "P"]);
    });

    test("paging walks that order at every page size, with nothing skipped or repeated", async () => {
      const h = await steered(setup());
      await reply(h, "t1", "R1");
      await reply(h, "t2", "R2");
      user(h, "U3");
      const all = (await get(h)).items.map(label);
      expect(all).toEqual(["U1", "R1", "U2", "R2", "U3"]);
      for (let limit = 1; limit <= all.length; limit++) expect(await walk(h, limit)).toEqual(all);
      const split = await get(h, "?limit=3");
      expect(split.items.map(label)).toEqual(["U2", "R2", "U3"]);
      expect((await get(h, `?limit=1&before=${split.before}`)).items.map(label)).toEqual(["R1"]);
    });

    test("a turn's start survives a bot restart, and a reply with no known start keeps its own place", async () => {
      const first = await steered(setup());
      const h = setup({ db: first.db });
      await h.adapter.progressReopen(null, "t1");
      await reply(h, "t1", "R1");
      await reply(h, "unseen", "R3");
      expect((await get(h)).items.map(label)).toEqual(["U1", "R1", "U2", "R3"]);
    });
  });

  test("the cursor is a seq, which may be zero or negative; anything else is a 400", async () => {
    const h = setup();
    for (const bad of ["abc", "1.5", "", "1e3", "--1", "1:", ":1", "1:2:3"]) expect((await call(h.handler, `/api/chat/history?before=${bad}`)).status).toBe(400);
    for (const ok of ["0", "-3", "12", "4:9", "-2:-1"]) expect((await call(h.handler, `/api/chat/history?before=${ok}`)).status).toBe(200);
    expect((await call(h.handler, "/api/chat/history?limit=0")).status).toBe(400);
  });

  test("imported messages page before every live one and carry no clientId", async () => {
    const h = setup();
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "live" });
    await h.routes.idle();
    h.log.prepend([
      { type: "reply", key: "pi:s:2", data: { key: "pi:s:2", text: "old answer", files: [] }, createdAt: 2_000 },
      { type: "user", key: "pi:s:1", data: { key: "pi:s:1", text: "old question", uploadIds: [], at: new Date(1_000).toISOString() }, createdAt: 1_000 },
    ]);
    const page = await get(h);
    expect(page.items.map((i) => (i.type === "user" || i.type === "assistant" ? i.text : i.type))).toEqual(["old question", "old answer", "live"]);
    expect(page.items[0]).not.toHaveProperty("clientId");
    expect(page.items[2]).toMatchObject({ clientId: CLIENT });
  });
});

describe("stop and commands", () => {
  test("stop without a turn aborts; commands answer on the log", async () => {
    const h = setup();
    expect((await post(h.handler, "/api/chat/stop", {})).status).toBe(202);
    expect((await post(h.handler, "/api/chat/command", { command: "compact" })).status).toBe(202);
    await Bun.sleep(5);
    expect(h.log.list(["session"])).toEqual([]); // The workspace emits only successful boundaries.
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

describe("fix round: wire and trust boundaries", () => {
  const ledger = { isSent: () => false, markSent: () => {} };
  const NONCE = "abcdefghijklmnop";
  const view = { tool: "t", agentId: "main", agentName: "Main", fields: [] };

  test("the 202 says whether the message is already routed", async () => {
    const h = setup();
    expect(await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()).toEqual({ seq: 1, routed: false });
    await h.routes.idle();
    expect(await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()).toEqual({ seq: 1, routed: true });
  });

  test("an answer goes by the addressed card's own choices, and a reused askId can't redirect it", async () => {
    const h = setup();
    await h.adapter.askPrompt(null, { askId: "A", question: "Delete prod?", choices: ["No", "Yes"] }, { ledger, plain: false, outboxId: "o1" });
    await h.adapter.askPrompt(null, { askId: "A", question: "Keep prod?", choices: ["Yes", "No"] }, { ledger, plain: false, outboxId: "o2" });
    expect(await (await post(h.handler, "/api/chat/asks/A", { index: 0, label: "Yes" })).json()).toEqual({ status: "answered" });
    expect(h.link.answered.map((a) => [a.askId, a.choice])).toEqual([["A", { text: "No" }]]);
    expect(await (await post(h.handler, "/api/chat/asks/A", { index: 5, label: "x" })).json()).toEqual({ status: "inactive" });
  });

  test("a pending approval is on the first frame and after a reset", async () => {
    const h = setup();
    await h.adapter.approvalPrompt(null, view, NONCE);
    const hello = (await readFrames(await call(h.handler, "/api/chat/stream"), 1))[0]!;
    expect((hello.data as { pending: { approvals: { nonce: string }[] } }).pending.approvals.map((a) => a.nonce)).toEqual([NONCE]);
    const reset = (await readFrames(await call(h.handler, "/api/chat/stream?after=999"), 1))[0]!;
    expect(reset.event).toBe("reset");
    expect((reset.data as { pending: { approvals: { nonce: string }[] } }).pending.approvals.map((a) => a.nonce)).toEqual([NONCE]);
  });

  test("shutdown waits for routing, but only so long", async () => {
    const h = setup();
    h.link.hold = new Promise(() => {});
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "stuck" });
    const t0 = Date.now();
    await h.routes.drain(30);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("holistic fix round: delivery, refusals, dead asks, history time", () => {
  test("202 routed:false, the bot dies, the workspace reconnects before the app: the message reaches it exactly once", async () => {
    const first = setup();
    first.link.hold = new Promise(() => {}); // the process dies before chat/message reaches the workspace
    expect(await (await post(first.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()).toEqual({ seq: expect.any(Number), routed: false });
    expect(first.inbound.get(CLIENT)!.routedAt).toBeNull();

    const workspace = new FakeLink();
    const second = setup({ db: first.db, link: workspace });
    // The workspace link comes back first. No request has brought a verified actor yet, so nothing routes.
    second.routes.workspaceConnected();
    await second.routes.idle();
    expect(workspace.sent).toEqual([]);

    // The app's stream reconnects and says online; the app re-sends its posted entry.
    const hello = (await readFrames(await call(second.handler, "/api/chat/stream"), 1))[0]!;
    expect(hello.event).toBe("hello");
    expect((hello.data as { workspace: string }).workspace).toBe("online");
    await post(second.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await second.routes.idle();

    expect(workspace.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(second.log.list(["status"]).map((e) => e.data)).toEqual([{ clientId: CLIENT, state: "accepted" }]);
    expect(second.inbound.get(CLIENT)!.routedAt).not.toBeNull();
    expect(await (await post(second.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()).toMatchObject({ routed: true });
    await second.routes.idle();
    expect(workspace.sent).toHaveLength(1);
    expect(userEvents(second.log)).toHaveLength(1);
  });

  test("a re-drive of a message the workspace already took counts its duplicate as the receipt", async () => {
    const first = setup();
    first.link.hold = new Promise(() => {});
    await post(first.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    const workspace = new FakeLink();
    workspace.seen.add(CLIENT);
    const second = setup({ db: first.db, link: workspace });
    await readFrames(await call(second.handler, "/api/chat/stream"), 1);
    second.routes.workspaceConnected();
    await second.routes.idle();
    expect(workspace.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(second.log.list(["status"]).map((e) => e.data)).toEqual([{ clientId: CLIENT, state: "accepted" }]);
    expect(second.inbound.get(CLIENT)!.routedAt).not.toBeNull();
  });

  test("a reconnect re-routes stored messages in the order they were sent, without the app resending", async () => {
    const h = setup();
    h.link.connected = false;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "first" });
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT2, text: "second" });
    await h.routes.idle();
    expect(h.link.sent).toEqual([]);
    h.link.connected = true;
    h.routes.workspaceConnected();
    await until(() => h.link.sent.length === 2);
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.text)).toEqual(["first", "second"]);
    expect([h.inbound.get(CLIENT)!.routedAt, h.inbound.get(CLIENT2)!.routedAt].every((t) => t !== null)).toBe(true);
    h.routes.workspaceConnected();
    await h.routes.idle();
    expect(h.link.sent).toHaveLength(2);
  });

  test("a connected workspace that refuses a message: messageRejected for that message, no offline notice, and a retry re-routes it", async () => {
    const h = setup();
    const send = h.link.sendMessage;
    h.link.sendMessage = async () => {
      throw new RpcErrorReply("model auth failed", -32000);
    };
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    expect(h.log.list(["notice"]).map((e) => e.data)).toEqual([{ type: "messageRejected", error: "model auth failed", clientId: CLIENT }]);
    expect(h.inbound.get(CLIENT)!.routedAt).toBeNull();

    h.link.sendMessage = send;
    expect(await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()).toMatchObject({ routed: false });
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(h.inbound.get(CLIENT)!.routedAt).not.toBeNull();
  });

  test("an ask the workspace no longer waits on is resolved, so the first frame stops offering it", async () => {
    const h = setup();
    h.link.answerAsk = async () => ({ status: "inactive" as const }) as never;
    await h.adapter.askPrompt(null, { askId: "q1", question: "Which?", choices: ["red", "blue"] }, { ledger: { isSent: () => false, markSent: () => {} }, plain: false, outboxId: "o1" });
    expect(h.log.pending({ approvalsSince: 0, asks: 10 }).asks.map((a) => a.askId)).toEqual(["q1"]);
    // An out-of-range choice is a bad answer, not a dead ask.
    expect(await (await post(h.handler, "/api/chat/asks/q1", { index: 9, label: "x" })).json()).toEqual({ status: "inactive" });
    expect(h.log.list(["ask_resolved"])).toEqual([]);
    expect(await (await post(h.handler, "/api/chat/asks/q1", { index: 0, label: "red" })).json()).toEqual({ status: "inactive" });
    expect(h.log.list(["ask_resolved"]).map((e) => e.data)).toEqual([{ askId: "q1", answer: null }]);
    expect(h.log.pending({ approvalsSince: 0, asks: 10 }).asks).toEqual([]);
    const hello = (await readFrames(await call(h.handler, "/api/chat/stream"), 1))[0]!;
    expect((hello.data as { pending: { asks: unknown[] } }).pending.asks).toEqual([]);
  });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(1);
}

describe("row states and discard", () => {
  const del = (h: WebHandler, clientId: string, site?: string) => call(h, `/api/chat/messages/${clientId}`, { method: "DELETE", ...(site ? { site } : {}) });
  const rejectAll = (link: FakeLink) => {
    const send = link.sendMessage;
    link.sendMessage = async () => {
      throw new RpcErrorReply("model auth failed", -32000);
    };
    return () => (link.sendMessage = send);
  };

  test("delete then reconnect: the message never reaches the workspace, and a resend is refused", async () => {
    const h = setup();
    h.link.connected = false;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "never mind" });
    await h.routes.idle();
    const res = await del(h.handler, CLIENT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discarded: true });
    expect(h.inbound.get(CLIENT)!.state).toBe("discarded");

    h.link.connected = true;
    h.routes.workspaceConnected();
    await h.routes.idle();
    const again = await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "never mind" });
    expect(again.status).toBe(410);
    await h.routes.idle();
    expect(h.link.sent).toEqual([]);
    expect(h.inbound.get(CLIENT)!.state).toBe("discarded");
  });

  test("delete after routed is 409 routed; an unknown id is 404; a cross-site delete is refused", async () => {
    const h = setup();
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    const res = await del(h.handler, CLIENT);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ routed: true });
    expect(h.inbound.get(CLIENT)!.state).toBe("routed");
    expect((await del(h.handler, CLIENT2)).status).toBe(404);
    expect((await del(h.handler, "not-a-ulid")).status).toBe(404);
    const third = "01J9Z3W8K2M4N6P8Q0R2S4T6VB";
    await post(h.handler, "/api/chat/messages", { clientId: third, text: "x" });
    await h.routes.idle();
    expect((await del(h.handler, third, "cross-site")).status).toBe(403);
  });

  test("rejected then reconnect: not re-routed, and no second refusal line", async () => {
    const h = setup();
    const restore = rejectAll(h.link);
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    expect(h.inbound.get(CLIENT)!.state).toBe("rejected");
    restore();
    h.routes.workspaceConnected();
    await h.routes.idle();
    expect(h.link.sent).toEqual([]);
    expect(h.log.list(["notice"]).filter((e) => e.data.type === "messageRejected")).toHaveLength(1);
  });

  test("rejected then Retry: routed once, back through pending", async () => {
    const h = setup();
    const restore = rejectAll(h.link);
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    restore();
    expect(await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()).toMatchObject({ routed: false });
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(h.inbound.get(CLIENT)!.state).toBe("routed");
    expect(await (await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" })).json()).toMatchObject({ routed: true });
    await h.routes.idle();
    expect(h.link.sent).toHaveLength(1);
  });

  test("a rejected message can be discarded", async () => {
    const h = setup();
    rejectAll(h.link);
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "hi" });
    await h.routes.idle();
    expect((await del(h.handler, CLIENT)).status).toBe(200);
    expect(h.inbound.get(CLIENT)!.state).toBe("discarded");
  });

  test("discard racing a re-drive: a delete during the route waits and reports it delivered; one first stops the route", async () => {
    const h = setup();
    h.link.connected = false;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "one" });
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT2, text: "two" });
    await h.routes.idle();
    h.link.connected = true;

    // The delete for CLIENT2 lands before the re-drive reaches it: it is never sent.
    let release!: () => void;
    h.link.hold = new Promise((r) => (release = r));
    h.routes.workspaceConnected();
    await until(() => h.link.sent.length === 1);
    expect(h.link.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    const late = del(h.handler, CLIENT);
    const early = await del(h.handler, CLIENT2);
    expect(early.status).toBe(200);
    release();
    const lateRes = await late;
    expect(lateRes.status).toBe(409);
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(h.inbound.get(CLIENT)!.state).toBe("routed");
    expect(h.inbound.get(CLIENT2)!.state).toBe("discarded");
  });

  test("a delete that beats its own POST leaves a tombstone: the late POST gets 410 and is never delivered", async () => {
    const h = setup();
    expect((await del(h.handler, CLIENT)).status).toBe(404);
    const late = await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "deleted before it landed" });
    expect(late.status).toBe(410);
    expect(await late.json()).toEqual({ discarded: true });
    await h.routes.idle();
    h.routes.workspaceConnected();
    await h.routes.idle();
    expect(h.link.sent).toEqual([]);
    expect(userEvents(h.log)).toEqual([]);
    // The tombstone goes with the same retention as any unrouted row.
    h.inbound.prune(Date.now() + INBOUND_RETENTION_MS + 1);
    expect(h.inbound.get(CLIENT)).toBeNull();
  });

  test("a reconnect during a running re-drive schedules another pass when it ends", async () => {
    const h = setup();
    h.link.connected = false;
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "one" });
    await h.routes.idle();
    h.link.connected = true;
    let release!: () => void;
    h.link.hold = new Promise((r) => (release = r));
    h.routes.workspaceConnected();
    await until(() => h.link.sent.length === 1);
    // A row that went pending while the first pass was already past it.
    h.inbound.insert({ clientId: CLIENT2, text: "two", uploadIds: [], seq: 99, createdAt: Date.now() });
    h.routes.workspaceConnected();
    h.link.hold = null;
    release();
    await until(() => h.link.sent.length === 2);
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.text)).toEqual(["one", "two"]);
  });

  test("a route that never settles is reported delivered, never discarded under it", async () => {
    const h = setup({ discardWaitMs: 30 });
    h.link.hold = new Promise(() => {});
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "stuck" });
    const res = await del(h.handler, CLIENT);
    expect(res.status).toBe(409);
    expect(h.inbound.get(CLIENT)!.state).toBe("pending");
  });
});


test("location replies require gateway identity, same-origin, strict bounded input and live nonce", async () => {
  const h = setup();
  const conn = { principalId: "owner" } as ConnectionInfo;
  const pending = h.location.request(conn, { principalId: "owner", callId: "location1", name: "request_current_location", agentId: "main", agentName: "main", args: { reason: "nearby" } });
  await Promise.resolve();
  const event = h.log.list(["approval"]).at(-1)!;
  const nonce = (event.data as { nonce: string }).nonce;
  const path = `/api/chat/location/${nonce}`;
  const body = { status: "shared", latitude: 42.123456, longitude: 8.123456, accuracy: 9, timestamp: Date.now() };
  expect((await call(h.handler, path, { body, headers: { "Tailscale-User-Login": "other@example.com" } })).status).toBe(403);
  expect((await call(h.handler, path, { body, site: "cross-site" })).status).toBe(403);
  expect((await post(h.handler, path, { ...body, longitude: 181 })).status).toBe(400);
  expect((await post(h.handler, path, { ...body, conversationId: "other" })).status).toBe(400);
  expect((await post(h.handler, path, { ...body, junk: "x".repeat(2048) })).status).toBe(413);
  expect(await (await post(h.handler, path, body)).json()).toEqual({ status: "decided" });
  expect((await pending).ok).toBe(true);
  expect(await (await post(h.handler, path, body)).json()).toEqual({ status: "expired" });
  expect(JSON.stringify(h.log.list(["approval", "approval_resolved"]))).not.toContain("42.123456");
  h.db.close();
});

describe("the server-side queue: a send while a turn runs is held by the bot", () => {
  const turn = (turnId: string) => ({ turnId, startedAt: 0, lines: [], toolCount: 0, text: "" });
  const statuses = (h: ReturnType<typeof setup>) => h.log.list(["status"]).map((e) => e.data);

  test("POST during a turn: 202 routed:false, acked queued, the row stays pending", async () => {
    const h = setup();
    await h.adapter.progressCreate(null, turn("t1"));
    const res = await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "later" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ seq: expect.any(Number), routed: false });
    await h.routes.idle();
    expect(h.link.sent).toHaveLength(0);
    expect(h.inbound.get(CLIENT)).toMatchObject({ state: "pending", routedAt: null });
    expect(statuses(h)).toEqual([{ clientId: CLIENT, state: "queued" }]);
    // A resend of the held message does not route it either, and does not queue-ack twice.
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "later" });
    await h.routes.idle();
    expect(h.link.sent).toHaveLength(0);
    expect(statuses(h)).toEqual([{ clientId: CLIENT, state: "queued" }]);
  });

  test("a reconnect mid-turn does not re-route queued rows; the turn's end does, in typed order", async () => {
    const h = setup();
    await h.adapter.progressCreate(null, turn("t1"));
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "first" });
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT2, text: "second" });
    // The link reconnects while the turn still runs: the queued rows stay put.
    h.routes.workspaceConnected();
    await h.routes.idle();
    expect(h.link.sent).toHaveLength(0);
    expect(h.inbound.get(CLIENT)!.state).toBe("pending");
    // The last open turn ends: both route now, oldest first.
    await h.adapter.progressFinalize(null, { id: "t1" }, { outcome: "done", summary: null });
    await until(() => h.link.sent.length === 2);
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.text)).toEqual(["first", "second"]);
    expect(h.inbound.get(CLIENT)!.state).toBe("routed");
    expect(h.inbound.get(CLIENT2)!.state).toBe("routed");
    expect(statuses(h)).toEqual([
      { clientId: CLIENT, state: "queued" },
      { clientId: CLIENT2, state: "queued" },
      { clientId: CLIENT, state: "accepted" },
      { clientId: CLIENT2, state: "accepted" },
    ]);
  });

  test("steer: the route drives the row mid-turn, and the steer ack settles it", async () => {
    const h = setup();
    h.link.sendMessage = async (i) => {
      h.link.sent.push(i);
      return { accepted: true, mode: "steer" };
    };
    await h.adapter.progressCreate(null, turn("t1"));
    await post(h.handler, "/api/chat/messages", { clientId: CLIENT, text: "steer me" });
    expect(h.link.sent).toHaveLength(0);
    expect(await (await post(h.handler, `/api/chat/messages/${CLIENT}/steer`, {})).json()).toEqual({ seq: expect.any(Number), routed: false });
    await h.routes.idle();
    expect(h.link.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(h.inbound.get(CLIENT)!.state).toBe("routed");
    expect(statuses(h)).toEqual([
      { clientId: CLIENT, state: "queued" },
      { clientId: CLIENT, state: "steer" },
    ]);
    // Unknown or malformed ids are never found; only POST steers.
    expect((await post(h.handler, "/api/chat/messages/01J9Z3W8K2M4N6P8Q0R2S4T6ZZ/steer", {})).status).toBe(404);
    expect((await post(h.handler, "/api/chat/messages/nope/steer", {})).status).toBe(404);
    expect((await call(h.handler, `/api/chat/messages/${CLIENT}/steer`, { method: "GET" })).status).toBe(405);
  });

  test("a bot restart re-routes a queued row when the link reconnects", async () => {
    const first = setup();
    await first.adapter.progressCreate(null, turn("t1"));
    await post(first.handler, "/api/chat/messages", { clientId: CLIENT, text: "held" });
    await first.routes.idle();
    expect(first.link.sent).toHaveLength(0);

    const workspace = new FakeLink();
    const second = setup({ db: first.db, link: workspace });
    // The restart lost the turn, so the reconnect's re-drive delivers what was queued behind it.
    await readFrames(await call(second.handler, "/api/chat/stream"), 1);
    second.routes.workspaceConnected();
    await second.routes.idle();
    expect(workspace.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(second.inbound.get(CLIENT)!.state).toBe("routed");
    expect(statuses(second)).toEqual([
      { clientId: CLIENT, state: "queued" },
      { clientId: CLIENT, state: "accepted" },
    ]);
  });

  test("a queued row the workspace already took settles on its duplicate receipt", async () => {
    const first = setup();
    await first.adapter.progressCreate(null, turn("t1"));
    await post(first.handler, "/api/chat/messages", { clientId: CLIENT, text: "held" });
    await first.routes.idle();

    const workspace = new FakeLink();
    workspace.seen.add(CLIENT); // the workspace took it before the restart and remembers the id
    const second = setup({ db: first.db, link: workspace });
    await readFrames(await call(second.handler, "/api/chat/stream"), 1);
    second.routes.workspaceConnected();
    await second.routes.idle();
    expect(workspace.sent.map((m) => m.messageId)).toEqual([CLIENT]);
    expect(second.inbound.get(CLIENT)!.state).toBe("routed");
    expect(statuses(second)).toEqual([
      { clientId: CLIENT, state: "queued" },
      { clientId: CLIENT, state: "accepted" },
    ]);
  });
});
