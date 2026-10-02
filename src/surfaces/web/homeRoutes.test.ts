import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import type { RunSummary, RunsListResult } from "../../orchestration/contracts.ts";
import { RpcErrorReply, RpcTimeoutError } from "../../orchestration/transport/server.ts";
import { WorkspaceBadResponseError } from "../../orchestration/workspace/link.ts";
import { SqliteChatLog } from "./chatLog.ts";
import type { HomeResponse } from "./events.ts";
import { createHomeRoutes, type HomeLink } from "./homeRoutes.ts";
import { WebHomeStore } from "./homeStore.ts";
import { createPeerMatcher } from "./peers.ts";
import { createWebHandler } from "./server.ts";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
let ids = 0;
/** Valid ULIDs, increasing. */
const rid = () => `01J${String(++ids).padStart(23, "0")}`;

function run(o: Partial<RunSummary> & Pick<RunSummary, "kind" | "status">): RunSummary {
  return { runId: rid(), agentName: o.kind === "job" ? "job:x" : "helper", title: "t", startedAt: iso(NOW - 80 * HOUR), resultSummary: "Did a thing.", ...o };
}

function setup(opts: { connected?: boolean; enabled?: boolean; loginPending?: boolean; runs?: (q: Parameters<HomeLink["runsList"]>[0]) => Promise<RunsListResult> } = {}) {
  const db = new Database(":memory:");
  applySchema(db);
  const log = new SqliteChatLog(db, { now: () => NOW });
  const store = new WebHomeStore(db, { now: () => NOW });
  const calls: Array<Parameters<HomeLink["runsList"]>[0]> = [];
  const link: HomeLink = {
    isConnected: () => opts.connected ?? true,
    isLoginPending: () => opts.loginPending ?? false,
    runsList: async (q) => (calls.push(q), opts.runs ? opts.runs(q) : { runs: [], before: null, truncated: false }),
  };
  const routes = createHomeRoutes({ log, adapter: { openTurns: () => [] }, store, link, workspaceEnabled: opts.enabled ?? true, now: () => NOW });
  const get = async () => {
    const res = await routes.handle(new Request("http://x/api/home"), "/api/home");
    expect(res!.status).toBe(200);
    return (await res!.json()) as HomeResponse;
  };
  const post = (path: string, body: unknown, type = "application/json") =>
    routes.handle(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": type } }), path);
  return { db, log, store, routes, calls, get, post };
}

/** Answers the running call from `running` and each finished call with the runs of its statuses. */
const lists = (running: RunSummary[], finished: RunSummary[]) => async (q: Parameters<HomeLink["runsList"]>[0]) => ({
  runs: q.statuses?.includes("running") ? running : finished.filter((r) => q.statuses?.includes(r.status)),
  before: null,
  truncated: false,
});

describe("GET /api/home", () => {
  test("groups running, failed and ready-for-review runs, bounded by endedAt within 72 h", async () => {
    const cutoff = NOW - 72 * HOUR;
    const running = run({ kind: "job", status: "running", jobName: "x" });
    const failedIn = run({ kind: "subagent", status: "failed", endedAt: iso(cutoff) });
    const timeoutIn = run({ kind: "agent", status: "timeout", endedAt: iso(NOW - HOUR) });
    const failedOut = run({ kind: "subagent", status: "failed", endedAt: iso(cutoff - 1) });
    const jobFailed = run({ kind: "job", status: "failed", endedAt: iso(NOW - HOUR) });
    const doneJob = run({ kind: "job", status: "done", endedAt: iso(NOW - 2 * HOUR) });
    const doneAgent = run({ kind: "agent", status: "done", endedAt: iso(NOW - 3 * HOUR) });
    // Its result already reached the chat through the agent that delegated it.
    const doneSubagent = run({ kind: "subagent", status: "done", endedAt: iso(NOW - HOUR) });
    const doneOld = run({ kind: "subagent", status: "done", endedAt: iso(cutoff - 1) });
    const noEnd = run({ kind: "subagent", status: "done" });
    const badEnd = run({ kind: "subagent", status: "failed", endedAt: "yesterday" });
    // Kinds the request excluded, in case the workspace ignores the filter.
    const chatDone = run({ kind: "chat", status: "done", endedAt: iso(NOW - HOUR) });
    const chatRunning = run({ kind: "chat", status: "running" });
    // Runs that delivered nothing aren't worth a review.
    const quietHeartbeat = run({ kind: "job", status: "done", endedAt: iso(NOW - HOUR), resultSummary: "NO_REPLY" });
    const silent = run({ kind: "subagent", status: "done", endedAt: iso(NOW - HOUR), resultSummary: undefined });
    const h = setup({
      runs: lists([running, chatRunning], [failedIn, timeoutIn, failedOut, jobFailed, doneJob, doneAgent, doneSubagent, doneOld, noEnd, badEnd, chatDone, quietHeartbeat, silent]),
    });

    const home = await h.get();
    // failedIn and doneJob started 80 h ago, before the window, and ended inside it.
    // Job messages are Home's inbox, not runs to review.
    expect(home.workspace).toEqual({ state: "online", running: [running], failedRuns: [timeoutIn, failedIn], review: [{ ...doneAgent, read: false }] });
    expect(doneJob.status).toBe("done");
    const since = iso(cutoff - 24 * HOUR);
    expect(h.calls).toEqual([
      { kinds: ["job", "subagent", "agent"], statuses: ["running"], limit: 50 },
      { kinds: ["subagent", "agent"], statuses: ["failed", "timeout"], since, limit: 50 },
      { kinds: ["agent"], statuses: ["done"], since, limit: 50 },
    ]);
  });

  test("a page full of finished runs can't crowd a failed one out", async () => {
    const done = Array.from({ length: 50 }, (_, i) => run({ kind: "job", status: "done", endedAt: iso(NOW - i * 60_000) }));
    const failed = run({ kind: "subagent", status: "failed", endedAt: iso(NOW - 40 * HOUR) });
    const h = setup({ runs: lists([], [...done, failed]) });
    expect(await h.get()).toMatchObject({ workspace: { state: "online", failedRuns: [failed] } });
  });

  test("an opened run stays in review as read; done takes it off until restored", async () => {
    const failed = run({ kind: "subagent", status: "failed", endedAt: iso(NOW - HOUR) });
    const done = run({ kind: "agent", status: "done", endedAt: iso(NOW - HOUR) });
    const h = setup({ runs: lists([], [failed, done]) });
    expect((await h.post("/api/home/dismiss", { id: `run:${failed.runId}` }))!.status).toBe(204);
    expect((await h.post("/api/home/opened", { id: `run:${done.runId}` }))!.status).toBe(204);
    expect((await h.post("/api/home/opened", { id: `run:${done.runId}` }))!.status).toBe(204);
    expect(await h.get()).toMatchObject({ workspace: { state: "online", failedRuns: [], review: [{ ...done, read: true }] } });
    expect((await h.post("/api/home/dismiss", { id: `run:${done.runId}` }))!.status).toBe(204);
    expect(await h.get()).toMatchObject({ workspace: { review: [] } });
    expect((await h.post("/api/home/restore", { id: `run:${done.runId}` }))!.status).toBe(204);
    expect(await h.get()).toMatchObject({ workspace: { review: [{ ...done, read: true }] } });
  });

  test("job messages stay in the inbox, read once opened, until done; restore brings one back", async () => {
    const h = setup({ connected: false });
    h.store.addMessage({ key: "o1", job: "heartbeat", runId: "01J0000000000000000000000A", text: "Passport due Friday." });
    h.store.addMessage({ key: "o2", job: "digest", text: "Two new invoices." });
    expect(h.store.addMessage({ key: "o2", job: "digest", text: "again" })).toBe(false);
    const inbox = (await h.get()).inbox;
    expect(inbox.map((m) => [m.key, m.read])).toEqual([["o2", false], ["o1", false]]);
    expect(inbox[1]).toEqual({ key: "o1", job: "heartbeat", runId: "01J0000000000000000000000A", text: "Passport due Friday.", at: iso(NOW), read: false });
    expect((await h.post("/api/home/opened", { id: "msg:o1" }))!.status).toBe(204);
    expect((await h.post("/api/home/dismiss", { id: "msg:o2" }))!.status).toBe(204);
    expect((await h.get()).inbox.map((m) => [m.key, m.read])).toEqual([["o1", true]]);
    expect((await h.post("/api/home/restore", { id: "msg:o2" }))!.status).toBe(204);
    // Undo brings each back as it was: unread, or read when opened before.
    expect((await h.get()).inbox.map((m) => [m.key, m.read])).toEqual([["o2", false], ["o1", true]]);
    expect((await h.post("/api/home/dismiss", { id: "msg:o1" }))!.status).toBe(204);
    expect((await h.post("/api/home/restore", { id: "msg:o1" }))!.status).toBe(204);
    expect((await h.post("/api/home/restore", { id: "msg:o1" }))!.status).toBe(204);
    expect((await h.get()).inbox.find((m) => m.key === "o1")?.read).toBe(true);
    for (const path of ["/api/home/opened", "/api/home/dismiss", "/api/home/restore"]) {
      expect((await h.post(path, { id: "msg:nope" }))!.status).toBe(404);
    }
  });

  test("each list holds at most 20 runs", async () => {
    const many = Array.from({ length: 30 }, (_, i) => run({ kind: "agent", status: "done", endedAt: iso(NOW - i * 1000) }));
    const h = setup({ runs: lists(many.map((r) => ({ ...r, status: "running" as const })), many) });
    const home = await h.get();
    if (home.workspace.state !== "online") throw new Error("offline");
    expect(home.workspace.review).toHaveLength(20);
    expect(home.workspace.review[0]).toEqual({ ...many[0]!, read: false });
    expect(home.workspace.running).toHaveLength(20);
  });

  test("the workspace part degrades to unsupported, timeout, bad_response or offline", async () => {
    const fail = (err: Error) => setup({ runs: async () => Promise.reject(err) });
    expect((await fail(new RpcErrorReply("method not found: runs/list", -32601)).get()).workspace).toEqual({ state: "unsupported" });
    expect((await fail(new RpcTimeoutError("runs/list timed out")).get()).workspace).toEqual({ state: "timeout" });
    expect((await fail(new WorkspaceBadResponseError("runs/list", new z.ZodError([]))).get()).workspace).toEqual({ state: "bad_response" });
    expect((await fail(new Error("socket closed")).get()).workspace).toEqual({ state: "offline" });
    const offline = setup({ connected: false });
    expect((await offline.get()).workspace).toEqual({ state: "offline" });
    expect(offline.calls).toEqual([]);
    expect((await setup({ enabled: false }).get()).workspace).toEqual({ state: "offline" });
    const hung = setup({ runs: () => new Promise(() => {}) });
    const slow = createHomeRoutes({ log: hung.log, adapter: { openTurns: () => [] }, store: hung.store, link: { isConnected: () => true, isLoginPending: () => false, runsList: () => new Promise(() => {}) }, workspaceEnabled: true, now: () => NOW, workspaceTimeoutMs: 20 });
    const res = await slow.handle(new Request("http://x/api/home"), "/api/home");
    expect(((await res!.json()) as HomeResponse).workspace).toEqual({ state: "timeout" });
  });

  test("open job alerts always appear in the inbox", async () => {
    const alert = { source: "job" as const, job: "nightly", kind: "failed" as const, trigger: "daily" as const, startedAt: iso(NOW - HOUR), schedule: "daily 04:00" };
    const on = setup();
    on.store.applyAlert(alert, 7, "o1");
    expect((await on.get()).failed).toEqual([{ id: "job:nightly", job: "nightly", kind: "failed", firstAt: alert.startedAt, lastAt: alert.startedAt, trigger: "daily", schedule: "daily 04:00", seq: 7 }]);
  });

  test("waiting carries pending approvals and asks from the log, and the sign-in link only while its login is pending", async () => {
    const pending = setup({ loginPending: true });
    pending.log.append("ask", { key: "k1", askId: "a1", question: "Which?", choices: ["x"] }, "k1");
    const authSeq = pending.log.append("auth", { key: "k2", url: "https://auth.example/x", instructions: "open it" }, "k2");
    const home = await pending.get();
    expect(home.waiting.asks.map((a) => a.askId)).toEqual(["a1"]);
    expect(home.waiting.auth).toEqual({ seq: authSeq, at: iso(NOW), key: "k2" });
    expect(home.asOf).toBe(iso(NOW));
    const done = setup({ loginPending: false });
    done.log.append("auth", { key: "k2", url: "https://auth.example/x", instructions: "open it" }, "k2");
    expect((await done.get()).waiting.auth).toBeNull();
  });
});

describe("POST /api/home/dismiss and /api/home/opened", () => {
  test("dismissing an open job alert publishes alert_cleared once", async () => {
    const h = setup();
    h.store.applyAlert({ source: "job", job: "nightly", kind: "failed", trigger: "daily", startedAt: iso(NOW), schedule: "s" }, 3, "o1");
    expect((await h.post("/api/home/dismiss", { id: "job:nightly" }))!.status).toBe(204);
    expect((await h.post("/api/home/dismiss", { id: "job:nightly" }))!.status).toBe(404);
    expect(h.log.list(["alert_cleared"]).map((e) => e.data)).toEqual([{ id: "job:nightly", reason: "dismissed" }]);
    expect((await h.get()).failed).toEqual([]);
  });

  test("ids outside the contract are refused", async () => {
    const h = setup();
    expect((await h.post("/api/home/dismiss", { id: "job:unknown" }))!.status).toBe(404);
    for (const id of ["job:Bad", "run:short", "turn:x", "approval:n", "run:01J00000000000000000000001/../x"]) {
      expect((await h.post("/api/home/dismiss", { id }))!.status).toBe(400);
    }
    expect((await h.post("/api/home/opened", { id: "job:nightly" }))!.status).toBe(400);
    expect((await h.post("/api/home/opened", { id: "run:01J0000000000000000000000A", extra: 1 }))!.status).toBe(400);
    expect((await h.post("/api/home/opened", { id: "run:01J0000000000000000000000A" }, "text/plain"))!.status).toBe(415);
    expect((await h.routes.handle(new Request("http://x/api/home/opened"), "/api/home/opened"))!.status).toBe(405);
    expect((await h.routes.handle(new Request("http://x/api/home", { method: "POST" }), "/api/home"))!.status).toBe(405);
    expect(await h.routes.handle(new Request("http://x/api/homes"), "/api/homes")).toBeNull();
  });
});

describe("Home behind the gateway", () => {
  const OWNER = "owner@example.com";
  const GW = "172.31.250.1";
  function gateway() {
    const h = setup();
    const config: WebConfig = { port: 0, bindAddr: "127.0.0.1", ownerLogin: OWNER, distDir: "/nonexistent", devLogin: undefined, trustedPeers: [GW], push: undefined };
    return createWebHandler({ config, peers: createPeerMatcher([GW]), home: h.routes });
  }
  const req = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Tailscale-User-Login", OWNER);
    return new Request(`http://apps.example.ts.net${path}`, { ...init, headers });
  };

  test("serves Home without feature configuration", async () => {
    const handler = gateway();
    expect((await handler(req("/api/home", { headers: { "Sec-Fetch-Site": "same-origin" } }), GW)).status).toBe(200);
  });

  test("needs Fetch-Metadata same-origin for reads and writes", async () => {
    const handler = gateway();
    expect((await handler(req("/api/home", { headers: { "Sec-Fetch-Site": "same-origin" } }), GW)).status).toBe(200);
    expect((await handler(req("/api/home", { headers: { "Sec-Fetch-Site": "cross-site" } }), GW)).status).toBe(403);
    const write = (site: string) =>
      req("/api/home/opened", { method: "POST", body: JSON.stringify({ id: "run:01J0000000000000000000000A" }), headers: { "Content-Type": "application/json", "Sec-Fetch-Site": site } });
    expect((await handler(write("same-site"), GW)).status).toBe(403);
    expect((await handler(write("same-origin"), GW)).status).toBe(204);
  });
});
