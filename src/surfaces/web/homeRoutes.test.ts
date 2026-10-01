import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import type { RunSummary, RunsListParams, RunsListResult } from "../../orchestration/contracts.ts";
import { RpcErrorReply, RpcTimeoutError } from "../../orchestration/transport/server.ts";
import { SqliteChatLog } from "./chatLog.ts";
import type { HomeResponse, WebFeature } from "./events.ts";
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
  return { runId: rid(), agentName: o.kind === "job" ? "job:x" : "helper", title: "t", startedAt: iso(NOW - 80 * HOUR), ...o };
}

function setup(opts: { features?: WebFeature[]; connected?: boolean; enabled?: boolean; loginPending?: boolean; runs?: (q: Omit<RunsListParams, "principalId">) => Promise<RunsListResult> } = {}) {
  const db = new Database(":memory:");
  applySchema(db);
  const log = new SqliteChatLog(db, { now: () => NOW });
  const store = new WebHomeStore(db, { now: () => NOW });
  const calls: Array<Omit<RunsListParams, "principalId">> = [];
  const link: HomeLink = {
    isConnected: () => opts.connected ?? true,
    isLoginPending: () => opts.loginPending ?? false,
    runsList: async (q) => (calls.push(q), opts.runs ? opts.runs(q) : { runs: [], before: null, truncated: false }),
  };
  const routes = createHomeRoutes({ log, adapter: { openTurns: () => [] }, store, link, workspaceEnabled: opts.enabled ?? true, features: opts.features ?? ["home", "alerts"], now: () => NOW });
  const get = async () => {
    const res = await routes.handle(new Request("http://x/api/home"), "/api/home");
    expect(res!.status).toBe(200);
    return (await res!.json()) as HomeResponse;
  };
  const post = (path: string, body: unknown, type = "application/json") =>
    routes.handle(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": type } }), path);
  return { db, log, store, routes, calls, get, post };
}

/** Answers the running call and the finished call from two lists. */
const lists = (running: RunSummary[], finished: RunSummary[]) => async (q: Omit<RunsListParams, "principalId">) => ({
  runs: q.statuses?.includes("running") ? running : finished,
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
    const doneOld = run({ kind: "subagent", status: "done", endedAt: iso(cutoff - 1) });
    const noEnd = run({ kind: "subagent", status: "done" });
    const badEnd = run({ kind: "subagent", status: "failed", endedAt: "yesterday" });
    const h = setup({ runs: lists([running], [failedIn, timeoutIn, failedOut, jobFailed, doneJob, doneAgent, doneOld, noEnd, badEnd]) });

    const home = await h.get();
    expect(home.workspace).toEqual({ state: "online", running: [running], failedRuns: [timeoutIn, failedIn], review: [doneJob, doneAgent] });
    expect(h.calls).toEqual([
      { kinds: ["job", "subagent", "agent"], statuses: ["running"], limit: 50 },
      { kinds: ["job", "subagent", "agent"], statuses: ["done", "failed", "timeout"], since: iso(cutoff), limit: 50 },
    ]);
  });

  test("opened runs leave review and dismissed runs leave failed, on the next load", async () => {
    const failed = run({ kind: "subagent", status: "failed", endedAt: iso(NOW - HOUR) });
    const done = run({ kind: "job", status: "done", endedAt: iso(NOW - HOUR) });
    const h = setup({ runs: lists([], [failed, done]) });
    expect((await h.post("/api/home/dismiss", { id: `run:${failed.runId}` }))!.status).toBe(204);
    expect((await h.post("/api/home/opened", { id: `run:${done.runId}` }))!.status).toBe(204);
    expect((await h.post("/api/home/opened", { id: `run:${done.runId}` }))!.status).toBe(204);
    expect(await h.get()).toMatchObject({ workspace: { state: "online", failedRuns: [], review: [] } });
  });

  test("each list holds at most 20 runs", async () => {
    const many = Array.from({ length: 30 }, (_, i) => run({ kind: "agent", status: "done", endedAt: iso(NOW - i * 1000) }));
    const h = setup({ runs: lists(many.map((r) => ({ ...r, status: "running" as const })), many) });
    const home = await h.get();
    if (home.workspace.state !== "online") throw new Error("offline");
    expect(home.workspace.review).toHaveLength(20);
    expect(home.workspace.review[0]).toEqual(many[0]);
    expect(home.workspace.running).toHaveLength(20);
  });

  test("the workspace part degrades to unsupported, timeout or offline", async () => {
    const fail = (err: Error) => setup({ runs: async () => Promise.reject(err) });
    expect((await fail(new RpcErrorReply("method not found: runs/list", -32601)).get()).workspace).toEqual({ state: "unsupported" });
    expect((await fail(new RpcTimeoutError("runs/list timed out")).get()).workspace).toEqual({ state: "timeout" });
    expect((await fail(new z.ZodError([])).get()).workspace).toEqual({ state: "offline" });
    const offline = setup({ connected: false });
    expect((await offline.get()).workspace).toEqual({ state: "offline" });
    expect(offline.calls).toEqual([]);
    expect((await setup({ enabled: false }).get()).workspace).toEqual({ state: "offline" });
  });

  test("open job alerts show only with the alerts feature", async () => {
    const alert = { source: "job" as const, job: "nightly", kind: "failed" as const, trigger: "daily" as const, startedAt: iso(NOW - HOUR), schedule: "daily 04:00" };
    const on = setup();
    on.store.applyAlert(alert, 7, "o1");
    expect((await on.get()).failed).toEqual([{ id: "job:nightly", job: "nightly", kind: "failed", firstAt: alert.startedAt, lastAt: alert.startedAt, trigger: "daily", schedule: "daily 04:00", seq: 7 }]);
    const off = setup({ features: ["home"] });
    off.store.applyAlert(alert, 7, "o1");
    expect((await off.get()).failed).toEqual([]);
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
  function gateway(features: WebFeature[]) {
    const h = setup();
    const config: WebConfig = { port: 0, bindAddr: "127.0.0.1", ownerLogin: OWNER, distDir: "/nonexistent", devLogin: undefined, trustedPeers: [GW], push: undefined, features };
    return createWebHandler({ config, peers: createPeerMatcher([GW]), home: h.routes });
  }
  const req = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Tailscale-User-Login", OWNER);
    return new Request(`http://apps.example.ts.net${path}`, { ...init, headers });
  };

  test("answers 404 while WEB_FEATURES lacks home", async () => {
    const handler = gateway(["alerts"]);
    expect((await handler(req("/api/home", { headers: { "Sec-Fetch-Site": "same-origin" } }), GW)).status).toBe(404);
  });

  test("needs Fetch-Metadata same-origin for reads and writes", async () => {
    const handler = gateway(["home"]);
    expect((await handler(req("/api/home", { headers: { "Sec-Fetch-Site": "same-origin" } }), GW)).status).toBe(200);
    expect((await handler(req("/api/home", { headers: { "Sec-Fetch-Site": "cross-site" } }), GW)).status).toBe(403);
    const write = (site: string) =>
      req("/api/home/opened", { method: "POST", body: JSON.stringify({ id: "run:01J0000000000000000000000A" }), headers: { "Content-Type": "application/json", "Sec-Fetch-Site": site } });
    expect((await handler(write("same-site"), GW)).status).toBe(403);
    expect((await handler(write("same-origin"), GW)).status).toBe(204);
  });
});
