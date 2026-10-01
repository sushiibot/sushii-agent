import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { WebConfig } from "../../config.ts";
import { applySchema } from "../../db/index.ts";
import { UNKNOWN_MODEL_CODE, historyDayResult, runsGetResult, type HistoryDayResult, type HistorySearchResult, type RunSummary, type RunsGetResult } from "../../orchestration/contracts.ts";
import { WorkspaceBadResponseError } from "../../orchestration/workspace/link.ts";
import { RpcConnectionClosedError, RpcErrorReply, RpcTimeoutError, WorkspaceNotConnectedError } from "../../orchestration/transport/server.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { HISTORY_RESPONSE_MAX } from "./chatRoutes.ts";
import { ChatIndex } from "./chatSearch.ts";
import type { ApprovalView, HistoryDayResponse, RunDetailResponse, SearchResponse, WebFeature } from "./events.ts";
import { createPeerMatcher } from "./peers.ts";
import { NOTES_SEARCHES_MAX, createReadRoutes, type ReadRouteLink } from "./readRoutes.ts";
import { RUN_FILES_SQL } from "./runJoins.ts";
import { createWebHandler } from "./server.ts";

const OWNER = "owner@example.com";
const GW = "172.31.250.1";
const RUN = "01J9ZZZZZZZZZZZZZZZZZZZZZA";
const CHILD = "01J9ZZZZZZZZZZZZZZZZZZZZZB";
const T0 = Date.parse("2026-09-30T10:00:00.000Z");

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  runId: RUN,
  kind: "chat",
  agentName: "main",
  title: "a run",
  status: "done",
  startedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0 + 60_000).toISOString(),
  ...over,
});

type Calls = { method: string; q: unknown }[];

class FakeLink implements ReadRouteLink {
  connected = true;
  calls: Calls = [];
  fail: unknown = null;
  getResult: RunsGetResult = { found: true, run: run(), children: [], session: "ok", steps: [], after: null };
  searchResult: HistorySearchResult = { hits: [], before: null, truncated: false };
  searchGate: Promise<void> | null = null;
  dayResult: HistoryDayResult | null = null;
  isConnected() {
    return this.connected;
  }
  private async go<T>(method: string, q: unknown, value: T): Promise<T> {
    this.calls.push({ method, q });
    if (this.fail) throw this.fail;
    return value;
  }
  runsList(q: object) {
    return this.go("runs/list", q, { runs: [run()], before: null, truncated: true });
  }
  runsGet(q: object) {
    return this.go("runs/get", q, this.getResult);
  }
  historyDays(q: object) {
    return this.go("history/days", q, { days: [{ date: "2026-09-30", runs: 2, sessions: 1 }], before: "2026-09-29" });
  }
  historyDay(q: { date: string }) {
    if (this.dayResult) return this.go("history/day", q, this.dayResult);
    return this.go("history/day", q, { found: true as const, date: q.date, sessions: [{ heading: "## x", markdown: "<b>y</b>" }], runs: [run()], truncated: false });
  }
  models = { current: "sol", models: [{ alias: "sol", backend: "chatgpt" as const, id: "gpt-6.1-sol" }, { alias: "luna", backend: "chatgpt" as const, id: "gpt-6-luna" }] };
  modelsGet() {
    return this.go("models/get", {}, this.models);
  }
  modelsSearch(query: string) {
    return this.go("models/search", { query }, { models: [{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", priceIn: 0.21 }] });
  }
  modelsSet(alias: string, role?: string) {
    if (role) this.calls.push({ method: "models/set:role", q: { alias, role } });
    if (!this.models.models.some((m) => m.alias === alias)) {
      this.calls.push({ method: "models/set", q: { alias } });
      return Promise.reject(new RpcErrorReply(`unknown model "${alias}"`, UNKNOWN_MODEL_CODE));
    }
    return this.go("models/set", { alias }, { ...this.models, current: alias });
  }
  async historySearch(q: object) {
    this.calls.push({ method: "history/search", q });
    if (this.searchGate) await this.searchGate;
    if (this.fail) throw this.fail;
    return this.searchResult;
  }
}

function setup(opts: { features?: WebFeature[]; workspaceEnabled?: boolean; now?: number } = {}) {
  const db = new Database(":memory:");
  applySchema(db);
  let t = T0;
  const log = new SqliteChatLog(db, { now: () => t, index: new ChatIndex(db) });
  const link = new FakeLink();
  const reads = createReadRoutes({ db, link, features: opts.features ?? ["runs", "history"], workspaceEnabled: opts.workspaceEnabled ?? true, now: () => opts.now ?? T0 + 120_000 });
  const config = { port: 0, bindAddr: "127.0.0.1", ownerLogin: OWNER, distDir: "/nonexistent", devLogin: undefined, trustedPeers: [GW] } as WebConfig;
  const handler = createWebHandler({ config, peers: createPeerMatcher([GW]), reads });
  const get = async (path: string, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }, method = "GET", peer = GW) => {
    const res = await handler(new Request(`http://apps.example.ts.net${path}`, { method, headers: { "Tailscale-User-Login": OWNER, ...headers } }), peer);
    return { status: res.status, body: res.headers.get("Content-Type")?.includes("json") ? ((await res.json()) as unknown) : await res.text() };
  };
  const post = async (path: string, body: unknown, type = "application/json") => {
    const res = await handler(
      new Request(`http://apps.example.ts.net${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Tailscale-User-Login": OWNER, "Sec-Fetch-Site": "same-origin", "Content-Type": type } }),
      GW,
    );
    return { status: res.status, body: res.headers.get("Content-Type")?.includes("json") ? ((await res.json()) as unknown) : await res.text() };
  };
  return { db, log, link, get, post, at: (ms: number) => (t = ms) };
}

describe("model routes", () => {
  test("GET reads the choice and POST switches it, whatever slices are on; bad bodies never reach the workspace", async () => {
    const h = setup({ features: [] });
    expect(await h.get("/api/models")).toEqual({ status: 200, body: h.link.models });
    expect(await h.post("/api/models", { alias: "luna" })).toEqual({ status: 200, body: { ...h.link.models, current: "luna" } });
    expect((await h.post("/api/models", { alias: "luna", extra: 1 })).status).toBe(400);
    expect((await h.post("/api/models", { alias: "" })).status).toBe(400);
    expect((await h.post("/api/models", { alias: "luna" }, "text/plain")).status).toBe(415);
    expect((await h.get("/api/models", undefined, "DELETE")).status).toBe(405);
    expect(await h.post("/api/models", { alias: "gone" })).toEqual({ status: 409, body: { error: "unknown_model" } });
    expect((await h.post("/api/models", { alias: "luna", role: "fallback" })).status).toBe(200);
    expect((await h.post("/api/models", { alias: "luna", role: "boss" })).status).toBe(400);
    expect(await h.get("/api/models/search?q=deep")).toEqual({ status: 200, body: { models: [{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", priceIn: 0.21 }] } });
    expect((await h.get(`/api/models/search?q=${"x".repeat(101)}`)).status).toBe(400);
    expect(h.link.calls.map((c) => c.method)).toEqual(["models/get", "models/set", "models/set", "models/set:role", "models/set", "models/search"]);
    h.link.connected = false;
    expect(await h.get("/api/models")).toEqual({ status: 503, body: { offline: true } });
  });
});

const PATHS = ["/api/runs", `/api/runs/${RUN}`, "/api/history/days", "/api/history/days/2026-09-30", "/api/search?q=hello"];

describe("read routes: guards", () => {
  test("every route needs the owner, a trusted peer and same-origin fetch metadata", async () => {
    const { link, get } = setup();
    for (const p of PATHS) {
      expect((await get(p, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
      expect((await get(p, { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
      expect((await get(p, { "Sec-Fetch-Site": "same-origin", "Tailscale-User-Login": "eve@example.com" })).status).toBe(403);
      expect((await get(p, { "Sec-Fetch-Site": "same-origin" }, "GET", "172.31.250.9")).status).toBe(403);
    }
    expect(link.calls).toEqual([]);
  });

  test("a route whose feature is off answers 404 without asking the workspace", async () => {
    const off = setup({ features: [] });
    for (const p of PATHS) expect((await off.get(p)).status).toBe(404);
    const runsOnly = setup({ features: ["runs"] });
    expect((await runsOnly.get("/api/runs")).status).toBe(200);
    expect((await runsOnly.get("/api/history/days")).status).toBe(404);
    expect((await runsOnly.get("/api/search?q=hello")).status).toBe(404);
    const historyOnly = setup({ features: ["history"] });
    expect((await historyOnly.get(`/api/runs/${RUN}`)).status).toBe(404);
    expect((await historyOnly.get("/api/search?q=hello")).status).toBe(200);
    expect(off.link.calls).toEqual([]);
  });

  test("only GET is allowed", async () => {
    const { get } = setup();
    for (const p of PATHS) expect((await get(p, { "Sec-Fetch-Site": "same-origin" }, "DELETE")).status).toBe(405);
  });

  test("bad ids and params are refused before the workspace is asked", async () => {
    const { link, get } = setup();
    expect((await get("/api/runs/not-a-run")).status).toBe(404);
    expect((await get(`/api/runs/${RUN.toLowerCase()}`)).status).toBe(404);
    expect((await get(`/api/runs/${RUN}/x`)).status).toBe(404);
    expect((await get("/api/history/days/2026-02-30")).status).toBe(404);
    expect((await get("/api/history/days/..%2F..%2Fetc")).status).toBe(404);
    for (const p of [
      "/api/runs?before=nope",
      "/api/runs?limit=0",
      "/api/runs?limit=51",
      "/api/runs?limit=1e3",
      "/api/runs?kind=chat,evil",
      "/api/runs?status=done,",
      `/api/runs/${RUN}?limit=201`,
      `/api/runs/${RUN}?after=${"x".repeat(300)}`,
      "/api/history/days?before=2026-02-30",
      "/api/history/days?limit=61",
      "/api/search",
      "/api/search?q=%20a%20",
      `/api/search?q=${"a".repeat(201)}`,
      "/api/search?q=ab%00",
    ]) {
      expect({ p, status: (await get(p)).status }).toEqual({ p, status: 400 });
    }
    expect(link.calls).toEqual([]);
  });
});

describe("read routes: workspace failures", () => {
  const cases: [string, unknown, number, object][] = [
    ["unsupported", new RpcErrorReply("method not found: runs/list", -32601), 501, { unsupported: true }],
    ["offline", new WorkspaceNotConnectedError("x"), 503, { offline: true }],
    ["closed", new RpcConnectionClosedError("x"), 503, { offline: true }],
    ["timeout", new RpcTimeoutError("x"), 504, { timeout: true }],
    ["bad response", new WorkspaceBadResponseError("runs/list"), 502, { bad_response: true }],
    ["refused", new RpcErrorReply("principal mismatch", -32000), 502, { bad_response: true }],
  ];
  for (const [name, err, status, body] of cases) {
    test(`${name} → ${status} on every workspace route`, async () => {
      const { link, get } = setup();
      link.fail = err;
      for (const p of PATHS.slice(0, 4)) expect(await get(p)).toEqual({ status, body });
    });
  }

  test("a cursor the workspace doesn't know is a 400", async () => {
    const { link, get } = setup();
    link.fail = new RpcErrorReply("unknown cursor", -32602);
    expect(await get(`/api/runs/${RUN}?after=gone`)).toEqual({ status: 400, body: { error: "invalid cursor" } });
    expect((await get("/api/runs?before=01J9ZZZZZZZZZZZZZZZZZZZZZC")).status).toBe(400);
  });

  test("an unexpected error is a logged 500, not offline", async () => {
    const { link, get } = setup();
    link.fail = new TypeError("boom");
    for (const p of PATHS) expect(await get(p)).toEqual({ status: 500, body: { error: "internal" } });
  });

  test("a body over the size cap is a bad response, even when it fits the contract", async () => {
    const { link, get } = setup();
    // CJK: 3 UTF-8 bytes per UTF-16 unit, so 50 recaps at the contract's max are ~4.8 MB.
    link.dayResult = historyDayResult.parse({
      found: true,
      date: "2026-09-30",
      sessions: Array.from({ length: 50 }, () => ({ heading: "## 会话", markdown: "東".repeat(32_000) })),
      runs: [],
      truncated: false,
    });
    expect(await get("/api/history/days/2026-09-30")).toEqual({ status: 502, body: { bad_response: true } });
    // Control characters: each one is a 6-byte JSON escape.
    link.getResult = runsGetResult.parse({
      found: true,
      run: run(),
      children: [],
      session: "ok",
      steps: Array.from({ length: 200 }, (_, i) => ({ type: "assistant", id: `s${i}`, at: "t", text: "\u0001".repeat(8_000) })),
      after: null,
    });
    expect(await get(`/api/runs/${RUN}`)).toEqual({ status: 502, body: { bad_response: true } });
    // Just under the cap still answers.
    link.dayResult = { found: true, date: "2026-09-30", sessions: [{ heading: "h", markdown: "東".repeat(Math.floor(HISTORY_RESPONSE_MAX / 3) - 1_000) }], runs: [], truncated: false };
    expect((await get("/api/history/days/2026-09-30")).status).toBe(200);
  });

  test("a disabled or disconnected workspace is 503 without a request", async () => {
    for (const s of [setup({ workspaceEnabled: false }), (() => {
      const x = setup();
      x.link.connected = false;
      return x;
    })()]) {
      for (const p of PATHS.slice(0, 4)) expect(await s.get(p)).toEqual({ status: 503, body: { offline: true } });
      expect(s.link.calls).toEqual([]);
    }
  });

  test("a run detail for another run id is a bad response", async () => {
    const { link, get } = setup();
    link.getResult = { found: true, run: run({ runId: CHILD }), children: [], session: "ok", steps: [], after: null };
    expect(await get(`/api/runs/${RUN}`)).toEqual({ status: 502, body: { bad_response: true } });
  });
});

describe("runs", () => {
  test("the list passes filters and cursors through", async () => {
    const { link, get } = setup();
    const res = await get(`/api/runs?before=${CHILD}&limit=10&kind=job,subagent,job&status=failed`);
    expect(res).toEqual({ status: 200, body: { runs: [run()], before: null, truncated: true } });
    expect(link.calls).toEqual([{ method: "runs/list", q: { before: CHILD, limit: 10, kinds: ["job", "subagent"], statuses: ["failed"] } }]);
  });

  test("found:false is a 404", async () => {
    const { link, get } = setup();
    link.getResult = { found: false };
    expect((await get(`/api/runs/${RUN}`)).status).toBe(404);
  });

  test("a run detail joins the bot's approvals and the files of its turn", async () => {
    const { log, link, get, at } = setup();
    const view = (agentId: string, tool = "file_linear_issue"): ApprovalView => ({ tool, agentId, agentName: agentId, fields: [] });
    at(T0 - 1000);
    log.append("approval", { nonce: "before", view: view("main") }, "before");
    at(T0 + 1000);
    log.append("approval", { nonce: "inside", view: view("main") }, "inside");
    log.append("approval_resolved", { nonce: "inside", decision: "approve" }, "inside");
    log.append("approval", { nonce: "sub", view: view(CHILD, "send_email") }, "sub");
    at(T0 + 2000);
    log.append("approval", { nonce: "pending", view: view("main") }, "pending");
    at(T0 + 120_000);
    log.append("approval", { nonce: "after", view: view("main") }, "after");
    const file = { id: "A".repeat(22), contentType: "image/png", bytes: 3, name: "a.png", inline: true };
    log.append("reply", { key: "o1", turnId: "turn-1", text: "here", files: [file] }, "o1");
    log.append("proactive", { key: "o2", turnId: "turn-1", text: "again", files: [file, { ...file, id: "B".repeat(22) }] }, "o2");
    log.append("reply", { key: "o3", turnId: "turn-2", text: "other", files: [{ ...file, id: "C".repeat(22) }] }, "o3");

    link.getResult = { found: true, run: run({ turnId: "turn-1" }), children: [run({ runId: CHILD, kind: "subagent", parentRunId: RUN })], session: "ok", steps: [], after: "s1" };
    const res = await get(`/api/runs/${RUN}?after=s0&limit=50`);
    expect(res.status).toBe(200);
    const body = res.body as RunDetailResponse;
    expect(body).not.toHaveProperty("found");
    expect(body.approvals).toEqual([
      { nonce: "inside", at: new Date(T0 + 1000).toISOString(), tool: "file_linear_issue", decision: "approve" },
      { nonce: "pending", at: new Date(T0 + 2000).toISOString(), tool: "file_linear_issue", decision: null },
    ]);
    expect(body.files.map((f) => f.id)).toEqual(["A".repeat(22), "B".repeat(22)]);
    expect(body.after).toBe("s1");
    expect(link.calls).toEqual([{ method: "runs/get", q: { runId: RUN, after: "s0", limit: 50 } }]);

    // A subagent's approvals match its runId at any time; a run without a turnId gets no files.
    link.getResult = { found: true, run: run({ runId: CHILD, kind: "subagent", agentName: "worker" }), children: [], session: "missing", steps: [], after: null };
    const sub = (await get(`/api/runs/${CHILD}`)).body as RunDetailResponse;
    expect(sub.approvals.map((a) => a.nonce)).toEqual(["sub"]);
    expect(sub.files).toEqual([]);
  });

  test("job, flush and rotate runs match in their half-open window; a finished run without endedAt matches only its id", async () => {
    const { log, link, get, at } = setup({ now: T0 + 10 * 60_000 });
    const approve = (nonce: string, agentId: string, ms: number) => {
      at(ms);
      log.append("approval", { nonce, view: { tool: "t", agentId, agentName: agentId, fields: [] } }, nonce);
    };
    approve("start", "main", T0);
    approve("end", "main", T0 + 60_000);
    approve("job-in", "job:nightly", T0 + 1_000);
    approve("job-other", "job:weekly", T0 + 1_000);
    approve("late", "main", T0 + 5 * 60_000);
    const nonces = async (r: RunSummary) => {
      link.getResult = { found: true, run: r, children: [], session: "ok", steps: [], after: null };
      return ((await get(`/api/runs/${RUN}`)).body as RunDetailResponse).approvals.map((x) => x.nonce);
    };
    for (const kind of ["chat", "flush", "rotate"] as const) expect(await nonces(run({ kind }))).toEqual(["start"]);
    expect(await nonces(run({ kind: "job", agentName: "job:nightly", jobName: "nightly" }))).toEqual(["job-in"]);
    expect(await nonces(run({ kind: "agent", agentName: "main" }))).toEqual([]);
    const { endedAt: _e, ...unended } = run({ status: "done" });
    expect(await nonces(unended)).toEqual([]);
    expect(await nonces({ ...unended, status: "running" })).toEqual(["start", "end", "late"]);
  });

  test("the files join is an index lookup by turnId", async () => {
    const { db } = setup();
    const plan = db
      .query(`EXPLAIN QUERY PLAN ${RUN_FILES_SQL}`)
      .all("t") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_web_events_turn");
  });

  test("a running run's window ends now", async () => {
    const { log, link, get, at } = setup({ now: T0 + 10_000 });
    at(T0 + 5_000);
    log.append("approval", { nonce: "n1", view: { tool: "t", agentId: "main", agentName: "main", fields: [] } }, "n1");
    at(T0 + 20_000);
    log.append("approval", { nonce: "n2", view: { tool: "t", agentId: "main", agentName: "main", fields: [] } }, "n2");
    const { endedAt: _drop, ...running } = run({ status: "running" });
    link.getResult = { found: true, run: running, children: [], session: "ok", steps: [], after: null };
    expect(((await get(`/api/runs/${RUN}`)).body as RunDetailResponse).approvals.map((a) => a.nonce)).toEqual(["n1"]);
  });
});

describe("history", () => {
  test("days and a day pass through", async () => {
    const { link, get } = setup();
    expect(await get("/api/history/days?before=2026-10-01&limit=5")).toEqual({
      status: 200,
      body: { days: [{ date: "2026-09-30", runs: 2, sessions: 1 }], before: "2026-09-29" },
    });
    const day = await get("/api/history/days/2026-09-30");
    expect(day.body as HistoryDayResponse).toEqual({ found: true, date: "2026-09-30", sessions: [{ heading: "## x", markdown: "<b>y</b>" }], runs: [run()], truncated: false });
    expect(link.calls).toEqual([
      { method: "history/days", q: { before: "2026-10-01", limit: 5 } },
      { method: "history/day", q: { date: "2026-09-30" } },
    ]);
  });
});

describe("search", () => {
  const notesHit = (date: string, line = 1) => ({ id: `${date}.md:${line}`, kind: "daily" as const, date, line, snippet: "otter notes", ranges: [[0, 5]] as [number, number][] });

  test("chat and notes merge newest first, labelled by source", async () => {
    const { log, link, get, at } = setup();
    at(Date.parse("2026-09-28T12:00:00Z"));
    const old = log.append("reply", { key: "r1", text: "otter from the 28th", files: [] }, "r1");
    at(Date.parse("2026-09-30T08:00:00Z"));
    const recent = log.append("user", { key: "u1", text: "otter today", uploadIds: [], at: "2026-09-30T08:00:00.000Z" }, "u1");
    link.searchResult = { hits: [notesHit("2026-09-29"), notesHit("2026-09-30", 4)], before: null, truncated: false };
    const res = await get("/api/search?q=%20otter%20");
    expect(res.status).toBe(200);
    const body = res.body as SearchResponse;
    expect(body.query).toBe("otter");
    expect(body.unavailable).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.hits.map((h) => `${h.source}:${h.id}`)).toEqual(["notes:2026-09-30.md:4", `chat:${recent}`, "notes:2026-09-29.md:1", `chat:${old}`]);
    expect(body.hits[1]).toEqual({ source: "chat", id: String(recent), at: "2026-09-30T08:00:00.000Z", role: "user", snippet: "otter today", ranges: [[0, 5]] });
    expect(link.calls).toEqual([{ method: "history/search", q: { query: "otter", limit: 20 } }]);
  });

  test("at most SEARCH_HITS_MAX hits, truncated when any source had more", async () => {
    const { log, link, get } = setup();
    for (let i = 0; i < 15; i++) log.append("reply", { key: `r${i}`, text: `beaver ${i}`, files: [] }, `r${i}`);
    link.searchResult = { hits: Array.from({ length: 10 }, (_, i) => notesHit(`2026-09-${String(10 + i)}`)), before: null, truncated: false };
    const body = (await get("/api/search?q=beaver")).body as SearchResponse;
    expect(body.hits).toHaveLength(20);
    expect(body.truncated).toBe(true);

    const small = setup();
    small.link.searchResult = { hits: [notesHit("2026-09-01")], before: "2026-09-01.md:1", truncated: false };
    expect(((await small.get("/api/search?q=beaver")).body as SearchResponse).truncated).toBe(true);
    small.link.searchResult = { hits: [], before: null, truncated: true };
    expect(((await small.get("/api/search?q=beaver")).body as SearchResponse).truncated).toBe(true);
    small.link.searchResult = { hits: [], before: null, truncated: false };
    expect(((await small.get("/api/search?q=beaver")).body as SearchResponse).truncated).toBe(false);
  });

  test("notes that can't be searched are listed as unavailable, and chat still answers 200", async () => {
    for (const err of [new RpcErrorReply("method not found", -32601), new RpcErrorReply("busy", -32001), new WorkspaceNotConnectedError("x"), new RpcTimeoutError("x"), new WorkspaceBadResponseError("history/search")]) {
      const { log, link, get } = setup();
      const seq = log.append("reply", { key: "r", text: "heron", files: [] }, "r");
      link.fail = err;
      const res = await get("/api/search?q=heron");
      expect(res.status).toBe(200);
      expect(res.body as SearchResponse).toMatchObject({ unavailable: ["notes"], hits: [{ source: "chat", id: String(seq) }] });
    }
    const off = setup({ workspaceEnabled: false });
    expect(((await off.get("/api/search?q=heron")).body as SearchResponse).unavailable).toEqual(["notes"]);
    expect(off.link.calls).toEqual([]);
  });

  test(`more than ${NOTES_SEARCHES_MAX} searches at once mark notes busy instead of queueing`, async () => {
    const { link, get } = setup();
    let release!: () => void;
    link.searchGate = new Promise((r) => (release = r));
    const first = [get("/api/search?q=crane"), get("/api/search?q=crane")];
    while (link.calls.filter((c) => c.method === "history/search").length < 2) await Bun.sleep(1);
    const third = await get("/api/search?q=crane");
    expect((third.body as SearchResponse).unavailable).toEqual(["notes"]);
    expect(link.calls.filter((c) => c.method === "history/search")).toHaveLength(2);
    release();
    for (const r of await Promise.all(first)) expect((r.body as SearchResponse).unavailable).toEqual([]);
    link.searchGate = null;
    expect(((await get("/api/search?q=crane")).body as SearchResponse).unavailable).toEqual([]);
  });

  test("a query within the code-point bound but past the notes bound skips notes", async () => {
    const { link, get } = setup();
    const res = await get(`/api/search?q=${encodeURIComponent("🦦".repeat(150))}`);
    expect(res.status).toBe(200);
    expect((res.body as SearchResponse).unavailable).toEqual(["notes"]);
    expect(link.calls).toEqual([]);
  });

  test("a broken chat index marks chat unavailable, and chat writes still land", async () => {
    const { db, log, get } = setup();
    db.run("DROP TABLE web_chat_fts");
    expect(log.append("reply", { key: "r", text: "heron", files: [] }, "r")).toBeGreaterThan(0);
    const body = (await get("/api/search?q=heron")).body as SearchResponse;
    expect(body.unavailable).toEqual(["chat"]);
  });

  test("injection-shaped queries answer 200 and match literally", async () => {
    const { log, get } = setup();
    log.append("user", { key: "b", text: "bravo", uploadIds: [], at: "2026-09-30T08:00:00.000Z" }, "b");
    for (const q of ['" OR "', "alpha OR bravo", "NEAR(a b)", "text:bravo", "bravo NOT x", "**", "^x", "-x", "((", '"x', "'; DROP TABLE web_events; --", "!!", "<script>"]) {
      const res = await get(`/api/search?q=${encodeURIComponent(q)}`);
      expect({ q, status: res.status, hits: (res.body as SearchResponse).hits.length }).toEqual({ q, status: 200, hits: 0 });
    }
    expect(((await get("/api/search?q=bravo")).body as SearchResponse).hits).toHaveLength(1);
  });
});
