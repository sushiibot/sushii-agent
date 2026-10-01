import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as contracts from "../../orchestration/contracts.ts";
import type * as Surface from "../../orchestration/workspace/surface.ts";
import type { JobTrigger } from "../../workspace/scheduler.ts";
import type * as Tools from "../../orchestration/workspace/tools.ts";
import type * as Link from "../../orchestration/workspace/link.ts";
import * as Wire from "./events.ts";

const SERVER_COPY = fileURLToPath(new URL("./events.ts", import.meta.url));
const CLIENT_COPY = fileURLToPath(new URL("../../../web/src/lib/core/realtime/events.ts", import.meta.url));

// Compile-time: every bot-side value that crosses the wire must fit its wire copy. The direction is
// server ⊆ wire, so a new RouterNotice or ToolLine state on the bot fails tsc here until the wire gains it.
type Assignable<From, To> = [From] extends [To] ? true : false;
// Shapes the bot passes through from the workspace must match in both directions.
type Same<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;
// Two-way assignability lets an optional field exist on one side only, so compare keys too.
type Exact<A, B> = Same<A, B> extends true ? Same<keyof A, keyof B> : false;
type Step<T, K extends string> = Extract<T, { type: K }>;
type StepsExact<A, B> = [
  Exact<Step<A, "user">, Step<B, "user">>,
  Exact<Step<A, "assistant">, Step<B, "assistant">>,
  Exact<Step<A, "tool">, Step<B, "tool">>,
  Exact<Step<A, "note">, Step<B, "note">>,
] extends [true, true, true, true]
  ? true
  : false;
type NotesFromWorkspace = contracts.SearchHit & { source: "notes" };
type FoundRun = Omit<Extract<contracts.RunsGetResult, { found: true }>, "found">;
const typeChecks: true[] = [
  true satisfies Assignable<contracts.ChatUsage, Wire.ChatUsage>,
  true satisfies Assignable<Surface.ToolLine, Wire.ToolLine>,
  true satisfies Assignable<Surface.ProgressView, Wire.ProgressView>,
  true satisfies Assignable<Surface.TurnOutcome, Wire.TurnOutcome>,
  true satisfies Assignable<NonNullable<Surface.ProgressFinal["summary"]>, NonNullable<Wire.ChatEventMap["turn_final"]["summary"]>>,
  true satisfies Assignable<Surface.ApprovalField, Wire.ApprovalField>,
  true satisfies Assignable<Surface.ApprovalView, Wire.ApprovalView>,
  true satisfies Assignable<Surface.RouterNotice, Wire.RouterNotice>,
  true satisfies Assignable<contracts.ToolCallResult, Wire.ToolCallResult>,
  true satisfies Assignable<Exclude<Surface.ApprovalDecision, "expired">, Wire.ApprovalDecision>,
  true satisfies Assignable<Exclude<Surface.AckKind, "transcribing">, Wire.ChatEventMap["status"]["state"]>,
  true satisfies Assignable<Wire.PostAskBody, Link.AskChoice>,
  true satisfies Assignable<Exclude<Link.AnswerAskResult["status"], "forbidden">, Wire.PostAskResponse["status"]>,
  true satisfies Assignable<Exclude<Tools.DecideResult, "forbidden">, Wire.PostApprovalResponse["status"]>,
  true satisfies Assignable<Wire.PostCommandBody["command"], "new" | contracts.ChatCommand>,
  true satisfies Same<contracts.RunKind, Wire.RunKind>,
  true satisfies Same<contracts.RunStatus, Wire.RunStatus>,
  true satisfies Exact<contracts.RunSummary, Wire.RunSummary>,
  true satisfies StepsExact<contracts.RunStep, Wire.RunStep>,
  true satisfies Exact<contracts.RunEvidence, Wire.RunEvidence>,
  true satisfies Exact<contracts.RunsListResult, Wire.RunsPage>,
  true satisfies Exact<FoundRun, Omit<Wire.RunDetailResponse, "approvals" | "files">>,
  true satisfies Exact<contracts.HistoryDaysResult, Wire.HistoryDaysPage>,
  true satisfies Same<contracts.HistoryDayResult, Wire.HistoryDayResponse>,
  true satisfies Exact<Extract<contracts.HistoryDayResult, { found: true }>, Extract<Wire.HistoryDayResponse, { found: true }>>,
  true satisfies Exact<NotesFromWorkspace, Wire.NotesHit>,
  true satisfies Exact<contracts.JobAlertWire, Wire.JobAlert>,
  true satisfies Same<JobTrigger, Wire.JobAlert["trigger"]>,
  true satisfies Exact<Omit<contracts.RunsChangedParams, "principalId">, Wire.ChatEventMap["run"]>,
  true satisfies Same<Exclude<contracts.JobAlertWire["kind"], "recovered">, Wire.HomeAlert["kind"]>,
  true satisfies Same<Wire.RunApprovalRecord["decision"], Wire.ApprovalDecision | null>,
  // Each event name sits in exactly one of the three lists.
  true satisfies Assignable<Wire.ChatEventType, Wire.FirstFrameEventType | Wire.DurableEventType | Wire.EphemeralEventType>,
];

describe("web events contract", () => {
  test("server and client copies are byte-identical", () => {
    const server = readFileSync(SERVER_COPY, "utf8").replace(/\r\n/g, "\n");
    const client = readFileSync(CLIENT_COPY, "utf8").replace(/\r\n/g, "\n");
    expect(server).toBe(client);
  });

  test("the copy imports nothing", () => {
    expect(readFileSync(SERVER_COPY, "utf8")).not.toMatch(/^\s*(import|export\s+\*\s+from|export\s+\{[^}]*\}\s+from)\b/m);
  });

  test("type checks are all true", () => expect(typeChecks.every(Boolean)).toBe(true));

  test("event lists are disjoint", () => {
    const all = [...Wire.FIRST_FRAME_EVENTS, ...Wire.DURABLE_EVENTS, ...Wire.EPHEMERAL_EVENTS];
    expect(new Set(all).size).toBe(all.length);
    expect(Wire.isDurableEvent("reply")).toBe(true);
    expect(Wire.isDurableEvent("delta")).toBe(false);
    expect(Wire.isDurableEvent("hello")).toBe(false);
  });

  test("limits and id rules match contracts.ts", () => {
    expect(Wire.UPLOAD_ID_RE.source).toBe(contracts.UPLOAD_ID_RE.source);
    expect(Wire.UPLOAD_MAX_BYTES).toBe(contracts.UPLOAD_MAX_BYTES);
    expect(Wire.RUN_ID_RE.source).toBe(contracts.RUN_ID_RE.source);
    expect(Wire.DATE_RE.source).toBe(contracts.DATE_RE.source);
    expect(Wire.JOB_NAME_RE.source).toBe(contracts.JOB_NAME_RE.source);
    expect(Wire.RUN_KINDS).toEqual(contracts.RUN_KINDS);
    expect(Wire.RUN_STATUSES).toEqual(contracts.RUN_STATUSES);
    expect(Wire.SEARCH_QUERY_MIN).toBe(contracts.HISTORY_QUERY_MIN);
    expect(Wire.SEARCH_QUERY_MAX).toBe(contracts.HISTORY_QUERY_MAX);
    expect(Wire.SEARCH_HITS_MAX).toBeLessThanOrEqual(contracts.HISTORY_SEARCH_PAGE_MAX);
  });

  test("alerts and alert clears are stored; run changes are not", () => {
    expect(Wire.isDurableEvent("alert")).toBe(true);
    expect(Wire.isDurableEvent("alert_cleared")).toBe(true);
    expect(Wire.isDurableEvent("run")).toBe(false);
    expect(Wire.EPHEMERAL_EVENTS).toContain("run");
  });

  test("web features", () => expect(Wire.WEB_FEATURES).toEqual(["runs", "history", "home", "alerts", "connectors"]));

  test("client ids are ULIDs", () => {
    expect(Wire.CLIENT_ID_RE.test("01J9ZQ8M3V7B6XKQ2T4R5S6Y7Z")).toBe(true);
    for (const id of ["01j9zq8m3v7b6xkq2t4r5s6y7z", "01J9ZQ8M3V7B6XKQ2T4R5S6Y7", "01J9ZQ8M3V7B6XKQ2T4R5S6Y7ZZ", "01J9ZQ8M3V7B6XKQ2T4R5S6Y7I", ""]) {
      expect(Wire.CLIENT_ID_RE.test(id)).toBe(false);
    }
  });

  test("fileUrl", () => expect(Wire.fileUrl("AbCdEfGhIjKlMnOpQrSt_-")).toBe("/f/AbCdEfGhIjKlMnOpQrSt_-"));

  const urls: [string, boolean][] = [
    ["https://auth.openai.com/oauth/authorize?state=s1", true],
    ["HTTPS://Auth.OpenAI.com/x", true],
    ["javascript:alert(1)", false],
    ["JavaScript:alert(1)", false],
    ["java\tscript:alert(1)", false],
    ["java\r\nscript:alert(1)", false],
    [" javascript:alert(1)", false],
    ["data:text/html,x", false],
    ["http://auth.openai.com/x", false],
    ["//auth.openai.com/x", false],
    ["/api/chat/stop", false],
    ["", false],
  ];
  test.each(urls)("isHttpsUrl(%p) is %p in both copies", (url, ok) => {
    expect(Wire.isHttpsUrl(url)).toBe(ok);
    expect(contracts.isHttpsUrl(url)).toBe(ok);
  });
});
