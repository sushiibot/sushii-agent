import { describe, expect, test } from "bun:test";
import {
  ALERT_ERROR_MAX,
  HISTORY_QUERY_MAX,
  HISTORY_SEARCH_TIMEOUT_MS,
  JOB_ALERT_KINDS,
  JOB_NAME_RE,
  RUN_KINDS,
  RUNS_TIMEOUT_MS,
  WORKSPACE_FEATURES,
  historyDate,
  historyDayParams,
  historyDayResult,
  historyDaysParams,
  historyDaysResult,
  historySearchParams,
  historySearchResult,
  runId as runIdSchema,
  runSummary,
  runsChangedParams,
  runsGetParams,
  runsGetResult,
  runsListParams,
  runsListResult,
  workspaceRegisterResult,
  chatDeliverParams,
  chatExportParams,
  chatExportResult,
  ID_MAX,
  isHttpsUrl,
  parseUploadUrl,
  RPC_METHODS,
  UPLOAD_MAX_BYTES,
  uploadReadParams,
  uploadReadResult,
  uploadUrl,
  webChatOrigin,
  webConversationId,
} from "./contracts.ts";

const UID = "AbCdEfGhIjKlMnOpQrSt_-";
const long = "x".repeat(ID_MAX + 1);

const HTTPS_ACCEPT = ["https://auth.openai.com/oauth/authorize?state=s1", "HTTPS://Auth.OpenAI.com/x", "https://example.com:8443/a#b"];
const HTTPS_REJECT = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  " javascript:alert(1)",
  "\u0000javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "http://auth.openai.com/x",
  "ftp://example.com/x",
  "//auth.openai.com/x",
  "/relative/path",
  "auth.openai.com/x",
  "",
];

describe("isHttpsUrl", () => {
  test.each(HTTPS_ACCEPT)("accepts %p", (url) => expect(isHttpsUrl(url)).toBe(true));
  test.each(HTTPS_REJECT)("rejects %p", (url) => expect(isHttpsUrl(url)).toBe(false));
});

describe("chat/deliver auth url", () => {
  const auth = (url: string) => ({ outboxId: "o1", principalId: "drk", kind: "auth", text: "Sign in", auth: { url, instructions: "paste" } });

  test.each(HTTPS_ACCEPT)("accepts %p", (url) => expect(chatDeliverParams.safeParse(auth(url)).success).toBe(true));
  test.each(HTTPS_REJECT)("rejects %p", (url) => expect(chatDeliverParams.safeParse(auth(url)).success).toBe(false));

  test("rejects a URL over 4096 chars", () => {
    expect(chatDeliverParams.safeParse(auth(`https://a.example/${"x".repeat(4096)}`)).success).toBe(false);
  });
});

describe("web conversation id", () => {
  test("Main and safe topic conversation ids", () => {
    expect(webConversationId.safeParse("main").success).toBe(true);
    for (const id of ["main ", "", "../other", "with/slash", "a".repeat(81)]) expect(webConversationId.safeParse(id).success).toBe(false);
  });

  test("web origin needs surface web and a safe conversation id", () => {
    expect(webChatOrigin.safeParse({ surface: "web", conversationId: "main" }).success).toBe(true);
    expect(webChatOrigin.safeParse({ surface: "discord", conversationId: "main" }).success).toBe(false);
    expect(webChatOrigin.safeParse({ surface: "web", conversationId: "other" }).success).toBe(true);
    expect(webChatOrigin.safeParse({ surface: "web", conversationId: "../other" }).success).toBe(false);
  });
});

describe("upload urls", () => {
  test("round-trips a valid id", () => {
    expect(uploadUrl(UID)).toBe(`upload:${UID}`);
    expect(parseUploadUrl(uploadUrl(UID))).toBe(UID);
  });

  test.each([
    "https://cdn.discordapp.com/x.png",
    `upload:${UID}x`,
    `upload:${UID.slice(1)}`,
    "upload:../../etc/passwd_aaaaaaaaaaa",
    "upload:AbCdEfGhIjKlMnOpQrSt/-",
    `UPLOAD:${UID}`,
    ` upload:${UID}`,
  ])("rejects %p", (url) => expect(parseUploadUrl(url)).toBeNull());
});

describe("chat/export", () => {
  test("method name", () => expect(RPC_METHODS.chatExport).toBe("chat/export"));

  test("params default to a full page from the newest", () => {
    expect(chatExportParams.parse({ principalId: "drk" })).toEqual({ principalId: "drk", limit: 100 });
    expect(chatExportParams.safeParse({ principalId: "drk", before: "2026-09-30T00-00-00_abc:e1f2", limit: 1 }).success).toBe(true);
  });

  test.each([
    { principalId: "drk", limit: 0 },
    { principalId: "drk", limit: 101 },
    { principalId: "drk", before: long },
    { principalId: "drk", before: 5 },
    { limit: 10 },
  ])("rejects params %j", (p) => expect(chatExportParams.safeParse(p).success).toBe(false));

  const user = { id: "s:e1", role: "user", at: "2026-09-30T10:00:00.000Z", text: "hi", clientId: "01J9ZQ8M3V7B6XKQ2T4R5S6Y7Z" };
  const reply = { id: "s:e2", role: "assistant", at: "2026-09-30T10:00:05.000Z", text: "hello", outboxId: "o1" };

  test("accepts owner messages and replies with a null cursor", () => {
    expect(chatExportResult.parse({ items: [user, reply], before: null }).items.map((i) => i.role)).toEqual(["user", "assistant"]);
  });

  test.each([
    ["an unknown role", { ...user, role: "tool" }],
    ["an empty id", { ...user, id: "" }],
    ["an oversized id", { ...user, id: long }],
    ["an oversized clientId", { ...user, clientId: long }],
    ["an oversized outboxId", { ...reply, outboxId: long }],
    ["an oversized time", { ...reply, at: long }],
  ])("rejects %s", (_, item) => expect(chatExportResult.safeParse({ items: [item], before: null }).success).toBe(false));

  test("rejects more than 100 items, an oversized cursor and a missing one", () => {
    expect(chatExportResult.safeParse({ items: Array.from({ length: 101 }, (_, i) => ({ ...user, id: `s:${i}` })), before: null }).success).toBe(false);
    expect(chatExportResult.safeParse({ items: [], before: long }).success).toBe(false);
    expect(chatExportResult.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("upload/read", () => {
  test("method name", () => expect(RPC_METHODS.uploadRead).toBe("upload/read"));

  test("params need a 22-char base64url id", () => {
    expect(uploadReadParams.safeParse({ principalId: "drk", uploadId: UID }).success).toBe(true);
    for (const uploadId of ["", UID.slice(1), `${UID}A`, "AbCdEfGhIjKlMnOpQrSt+/", "../../../../etc/passwd..", `${UID.slice(0, 21)}.`]) {
      expect(uploadReadParams.safeParse({ principalId: "drk", uploadId }).success).toBe(false);
    }
    expect(uploadReadParams.safeParse({ principalId: long, uploadId: UID }).success).toBe(false);
    expect(uploadReadParams.safeParse({ uploadId: UID }).success).toBe(false);
  });

  test("result: ok with padded base64, or an error", () => {
    expect(uploadReadResult.safeParse({ ok: true, name: "p.jpg", contentType: "image/jpeg", dataBase64: "AAAA" }).success).toBe(true);
    expect(uploadReadResult.safeParse({ ok: false, error: "not referenced" }).success).toBe(true);
  });

  test.each([
    ["unpadded base64", { ok: true, name: "p", contentType: "image/png", dataBase64: "AAA" }],
    ["non-base64", { ok: true, name: "p", contentType: "image/png", dataBase64: "AA*A" }],
    ["an empty content type", { ok: true, name: "p", contentType: "", dataBase64: "AAAA" }],
    ["an error without text", { ok: false }],
  ])("rejects %s", (_, r) => expect(uploadReadResult.safeParse(r).success).toBe(false));

  test("rejects bytes over the upload cap", () => {
    const over = "A".repeat(Math.ceil((UPLOAD_MAX_BYTES + 3) / 3) * 4);
    expect(uploadReadResult.safeParse({ ok: true, name: "p", contentType: "image/png", dataBase64: over }).success).toBe(false);
  });
});

// ── Runs, history and alerts. ──
const RUN = "01J9ZQ8M3V7B6XKQ2T4R5S6Y7Z";
const RUN2 = "01J9ZQ8M3V7B6XKQ2T4R5S6Y80";
const PRINCIPAL = { principalId: "owner" };
const summary = { runId: RUN, kind: "subagent", agentName: "writer", title: "Draft the summary", status: "done", startedAt: "2026-09-30T10:00:00.000Z" };
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(true);
const bad = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => expect(s.safeParse(v).success).toBe(false);

describe("ids", () => {
  test.each([RUN, "0123456789ABCDEFGHJKMNPQRS"])("run id %p", (id) => ok(runIdSchema, id));
  test.each(["01j9zq8m3v7b6xkq2t4r5s6y7z", RUN.slice(1), `${RUN}0`, "01J9ZQ8M3V7B6XKQ2T4R5S6Y7I", "01J9ZQ8M3V7B6XKQ2T4R5S6Y7U", "../../etc/passwd", ""])(
    "rejects run id %p",
    (id) => bad(runIdSchema, id),
  );
  test.each(["2026-09-30", "2024-02-29", "1999-12-31"])("date %p", (d) => ok(historyDate, d));
  test.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-9-30", "2026-09-30T00:00", "../2026-09-30", "2026-09-30\n", ""])("rejects date %p", (d) =>
    bad(historyDate, d),
  );
  test("job names", () => {
    expect(JOB_NAME_RE.test("nightly-sync")).toBe(true);
    expect(JOB_NAME_RE.test("a".repeat(64))).toBe(true);
    for (const n of ["a".repeat(65), "Nightly", "a_b", "a b", "", "../x"]) expect(JOB_NAME_RE.test(n)).toBe(false);
  });
});

describe("method names", () => {
  test("runs and history", () => {
    expect([RPC_METHODS.runsList, RPC_METHODS.runsGet, RPC_METHODS.historyDays, RPC_METHODS.historyDay, RPC_METHODS.historySearch, RPC_METHODS.runsChanged]).toEqual([
      "runs/list",
      "runs/get",
      "history/days",
      "history/day",
      "history/search",
      "runs/changed",
    ]);
    expect(RUNS_TIMEOUT_MS).toBe(10_000);
    expect(HISTORY_SEARCH_TIMEOUT_MS).toBe(8_000);
  });
});

describe("runs/list", () => {
  test("defaults to the newest 30", () => expect(runsListParams.parse(PRINCIPAL)).toEqual({ ...PRINCIPAL, limit: 30 }));
  test("accepts filters", () =>
    ok(runsListParams, { ...PRINCIPAL, before: RUN, limit: 50, kinds: ["job", "subagent"], statuses: ["running", "failed"], since: "2026-09-27T00:00:00.000Z", until: "2026-09-30T00:00:00Z" }));
  test.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { before: "not-a-run" },
    { kinds: ["chat", "nope"] },
    { kinds: [...RUN_KINDS, "chat"] },
    { statuses: ["succeeded"] },
    { since: "2026-09-27" },
    { since: "2026-09-27T00:00:00+02:00" },
    { principalId: long },
  ])("rejects %p", (extra) => bad(runsListParams, { ...PRINCIPAL, ...extra }));

  test("result: a page with a cursor or null", () => {
    ok(runsListResult, { runs: [summary], before: RUN, truncated: false });
    ok(runsListResult, { runs: [], before: null, truncated: true });
  });
  test.each([
    ["more than 50 runs", { runs: Array(51).fill(summary), before: null, truncated: false }],
    ["a cursor that isn't a run id", { runs: [], before: "x", truncated: false }],
    ["no truncated flag", { runs: [], before: null }],
  ])("result rejects %s", (_n, v) => bad(runsListResult, v));

  test("summary caps", () => {
    ok(runSummary, { ...summary, parentRunId: RUN2, turnId: "t1", jobName: "a".repeat(64), endedAt: "2026-09-30T10:05:00.000Z", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01, model: "m" }, resultSummary: "r".repeat(400) });
    for (const extra of [
      { title: "t".repeat(201) },
      { resultSummary: "r".repeat(401) },
      { jobName: "a".repeat(65) },
      { kind: "main" },
      { status: "verified" },
      { parentRunId: "p" },
      { startedAt: "x".repeat(41) },
      { usage: { inputTokens: -1, outputTokens: 0 } },
      { usage: { inputTokens: 1.5, outputTokens: 0 } },
      { agentName: long },
    ]) {
      bad(runSummary, { ...summary, ...extra });
    }
  });
});

describe("runs/get", () => {
  test("params", () => {
    expect(runsGetParams.parse({ ...PRINCIPAL, runId: RUN })).toEqual({ ...PRINCIPAL, runId: RUN, limit: 100 });
    ok(runsGetParams, { ...PRINCIPAL, runId: RUN, after: "s".repeat(ID_MAX), limit: 200 });
    for (const extra of [{ runId: "x" }, { after: long }, { limit: 201 }, { limit: 0 }]) bad(runsGetParams, { ...PRINCIPAL, runId: RUN, ...extra });
  });

  const at = "2026-09-30T10:00:01.000Z";
  const steps = [
    { type: "user", id: "s1", at, text: "u".repeat(4_000) },
    { type: "assistant", id: "s2", at, text: "a".repeat(8_000) },
    { type: "tool", id: "s3", at, name: "bash", args: "a".repeat(300), ok: null, result: "r".repeat(600), durationMs: 12, agentId: RUN2 },
    { type: "note", id: "s4", at, kind: "compaction", text: "n".repeat(600) },
  ];
  const found = {
    found: true,
    run: summary,
    children: [],
    session: "ok",
    steps,
    after: null,
    evidence: {
      checks: [{ command: "bun test", ok: true, at }],
      changedRepos: ["sushii-agent"],
      checkAfterLastChange: true,
      verifyNudged: false,
      filesSent: [{ name: "report.md", at }],
      memoryWrites: [{ path: "memory/notes.md", tool: "edit", at }],
    },
    historyFile: `2026-09/30-${RUN}.md`,
  };

  test("result: found with every step type, or not found", () => {
    ok(runsGetResult, found);
    ok(runsGetResult, { found: false });
    ok(runsGetResult, { ...found, evidence: undefined, session: "missing", steps: [], after: "cursor" });
  });
  test.each([
    ["a long user step", { steps: [{ ...steps[0], text: "u".repeat(4_001) }] }],
    ["a long assistant step", { steps: [{ ...steps[1], text: "a".repeat(8_001) }] }],
    ["long tool args", { steps: [{ ...steps[2], args: "a".repeat(301) }] }],
    ["a long tool result", { steps: [{ ...steps[2], result: "r".repeat(601) }] }],
    ["an unknown note kind", { steps: [{ ...steps[3], kind: "approval" }] }],
    ["an unknown step type", { steps: [{ type: "image", id: "s", at, data: "x" }] }],
    ["an empty step id", { steps: [{ ...steps[0], id: "" }] }],
    ["more than 200 steps", { steps: Array(201).fill(steps[0]) }],
    ["more than 50 children", { children: Array(51).fill(summary) }],
    ["an unknown session state", { session: "symlink" }],
    ["21 checks", { evidence: { ...found.evidence, checks: Array(21).fill(found.evidence.checks[0]) } }],
    ["51 files sent", { evidence: { ...found.evidence, filesSent: Array(51).fill(found.evidence.filesSent[0]) } }],
    ["a long memory path", { evidence: { ...found.evidence, memoryWrites: [{ path: "p".repeat(301), tool: "write", at }] } }],
    ["a long history file", { historyFile: "h".repeat(101) }],
  ])("result rejects %s", (_n, extra) => bad(runsGetResult, { ...found, ...extra }));
});

describe("history/days and history/day", () => {
  test("params", () => {
    expect(historyDaysParams.parse(PRINCIPAL)).toEqual({ ...PRINCIPAL, limit: 30 });
    ok(historyDaysParams, { ...PRINCIPAL, before: "2026-09-30", limit: 60 });
    for (const extra of [{ before: "2026-02-31" }, { limit: 61 }]) bad(historyDaysParams, { ...PRINCIPAL, ...extra });
    ok(historyDayParams, { ...PRINCIPAL, date: "2026-09-30" });
    for (const date of ["2026-09-31", "../../x", "2026-09-30.md"]) bad(historyDayParams, { ...PRINCIPAL, date });
  });

  test("days result", () => {
    ok(historyDaysResult, { days: [{ date: "2026-09-30", runs: 3, sessions: 1 }], before: "2026-09-30" });
    ok(historyDaysResult, { days: [], before: null });
    bad(historyDaysResult, { days: Array(61).fill({ date: "2026-09-30", runs: 0, sessions: 0 }), before: null });
    bad(historyDaysResult, { days: [{ date: "x", runs: 0, sessions: 0 }], before: null });
    bad(historyDaysResult, { days: [{ date: "2026-09-30", runs: -1, sessions: 0 }], before: null });
  });

  const day = { found: true, date: "2026-09-30", sessions: [{ heading: "Morning", markdown: "m".repeat(32_000) }], runs: [summary], truncated: false };
  test("day result", () => {
    ok(historyDayResult, day);
    ok(historyDayResult, { found: false });
  });
  test.each([
    ["a long recap", { sessions: [{ heading: "h", markdown: "m".repeat(32_001) }] }],
    ["a long heading", { sessions: [{ heading: "h".repeat(301), markdown: "" }] }],
    ["51 sessions", { sessions: Array(51).fill({ heading: "h", markdown: "" }) }],
    ["201 runs", { runs: Array(201).fill(summary) }],
    ["a bad date", { date: "2026-09-31" }],
  ])("day result rejects %s", (_n, extra) => bad(historyDayResult, { ...day, ...extra }));
});

describe("history/search", () => {
  test("params trim the query and default to 20 hits over everything", () => {
    expect(historySearchParams.parse({ ...PRINCIPAL, query: "  deploy " })).toEqual({ ...PRINCIPAL, query: "deploy", scope: "all", limit: 20 });
    ok(historySearchParams, { ...PRINCIPAL, query: "q".repeat(HISTORY_QUERY_MAX), scope: "runs", before: `2026-09/30-${RUN}.md:4`, limit: 50 });
  });
  test.each([
    { query: "a" },
    { query: "  a  " },
    { query: "q".repeat(HISTORY_QUERY_MAX + 1) },
    { query: "ok", scope: "sessions" },
    { query: "ok", limit: 51 },
    { query: "ok", before: long },
  ])("params reject %p", (extra) => bad(historySearchParams, { ...PRINCIPAL, ...extra }));

  const hit = { id: "2026-09-30.md:12", kind: "daily", date: "2026-09-30", line: 12, heading: "Sessions", snippet: "s".repeat(240), ranges: [[0, 2]] };
  test("result", () => {
    ok(historySearchResult, { hits: [hit, { ...hit, kind: "run", runId: RUN }], before: null, truncated: false });
    ok(historySearchResult, { hits: [], before: "2026-09-30.md:12", truncated: true });
  });
  test.each([
    ["51 hits", { hits: Array(51).fill(hit) }],
    ["a long snippet", { hits: [{ ...hit, snippet: "s".repeat(241) }] }],
    ["6 ranges", { hits: [{ ...hit, ranges: Array(6).fill([0, 1]) }] }],
    ["an empty range", { hits: [{ ...hit, ranges: [[3, 3]] }] }],
    ["a negative range", { hits: [{ ...hit, ranges: [[-1, 2]] }] }],
    ["line 0", { hits: [{ ...hit, line: 0 }] }],
    ["a bad run id", { hits: [{ ...hit, runId: "x" }] }],
    ["a long heading", { hits: [{ ...hit, heading: "h".repeat(201) }] }],
    ["a long cursor", { before: long }],
  ])("result rejects %s", (_n, extra) => bad(historySearchResult, { hits: [], before: null, truncated: false, ...extra }));
});

describe("runs/changed", () => {
  const base = { ...PRINCIPAL, runId: RUN, kind: "job", status: "running" };
  test("accepts", () => ok(runsChangedParams, { ...base, parentRunId: RUN2, jobName: "nightly-sync" }));
  test.each([{ runId: "x" }, { kind: "main" }, { status: "ok" }, { parentRunId: "p" }, { jobName: "a".repeat(65) }])("rejects %p", (extra) => bad(runsChangedParams, { ...base, ...extra }));
});

describe("chat/deliver kind alert", () => {
  const alert = { source: "job", job: "nightly-sync", kind: "failed", trigger: "daily", startedAt: "2026-09-30T04:00:00.000Z", error: "e".repeat(ALERT_ERROR_MAX), schedule: "daily 04:00", disabled: false, runId: RUN };
  const deliver = (extra: object) => ({ outboxId: "o1", principalId: "owner", kind: "alert", text: "⚠️ scheduled job failed", alert, ...extra });

  test("accepts an alert with its structured part", () => {
    ok(chatDeliverParams, deliver({}));
    for (const kind of JOB_ALERT_KINDS) ok(chatDeliverParams, deliver({ alert: { ...alert, kind } }));
    ok(chatDeliverParams, deliver({ alert: { source: "job", job: "j", kind: "recovered", trigger: "manual", startedAt: "2026-09-30T04:00:00Z", schedule: "" } }));
  });
  test("kind alert needs alert, and no other kind may carry one", () => {
    bad(chatDeliverParams, deliver({ alert: undefined }));
    for (const kind of ["reply", "proactive", "ask", "auth"]) bad(chatDeliverParams, deliver({ kind }));
    ok(chatDeliverParams, deliver({ kind: "proactive", alert: undefined }));
  });
  test.each([
    { source: "workspace" },
    { job: "Nightly" },
    { job: "a".repeat(65) },
    { kind: "warning" },
    { trigger: "cron" },
    { startedAt: "yesterday" },
    { startedAt: "2026-09-30T04:00:00+02:00" },
    { error: "e".repeat(ALERT_ERROR_MAX + 1) },
    { schedule: "s".repeat(121) },
    { runId: "x" },
  ])("rejects alert %p", (extra) => bad(chatDeliverParams, deliver({ alert: { ...alert, ...extra } })));
  test("rejects an unknown kind", () => bad(chatDeliverParams, deliver({ kind: "toast" })));
});

describe("register result features", () => {
  test("optional, a short list of short names", () => {
    ok(workspaceRegisterResult, { ok: true, tools: [] });
    expect(workspaceRegisterResult.parse({ ok: true, tools: [], features: [...WORKSPACE_FEATURES] }).features).toEqual(["alert", "session"]);
    ok(workspaceRegisterResult, { ok: true, tools: [], features: ["alert", "something-newer"] });
    bad(workspaceRegisterResult, { ok: true, tools: [], features: Array(17).fill("alert") });
    bad(workspaceRegisterResult, { ok: true, tools: [], features: ["x".repeat(33)] });
  });
});
