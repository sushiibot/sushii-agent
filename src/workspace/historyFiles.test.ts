import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyDayResult, historyDaysResult, type HistoryDayResult } from "../orchestration/contracts.ts";
import { HistoryWriter } from "./history.ts";
import { HISTORY_FILE_MAX, historyDay, historyDays, splitSessions, type HistoryReadOptions } from "./historyFiles.ts";
import { ulid } from "./ulid.ts";

const GH_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
const T0 = Date.parse("2026-09-29T10:00:00Z");

let root: string;
let home: string;
let hist: string;
let stateDir: string;
let opts: HistoryReadOptions;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-histread-"));
  home = join(root, "home");
  hist = join(home, "history");
  stateDir = join(root, ".workspace");
  mkdirSync(hist, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  opts = { principalId: "owner", home, stateDir };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const daily = (date: string, body: string) => writeFileSync(join(hist, `${date}.md`), body);
function runFile(date: string, runId: string, status = "done", kind = "job", agent = "job:nightly"): void {
  mkdirSync(join(hist, date.slice(0, 7)), { recursive: true });
  writeFileSync(join(hist, date.slice(0, 7), `${date.slice(8)}-${runId}.md`), `# ${kind} run ${runId}\n\n- **Agent:** ${kind} / ${agent}\n- **Status:** ${status}\n\n## Transcript\n`);
}
const day = async (date: string): Promise<Extract<HistoryDayResult, { found: true }>> => {
  const r = historyDayResult.parse(await historyDay(opts, { principalId: "owner", date }));
  if (!r.found) throw new Error("day not found");
  return r;
};

describe("splitSessions", () => {
  test("splits the Sessions section on the writer's headings, not on a recap's own demoted headings", () => {
    const text = [
      "# 2026-09-29",
      "",
      "## Runs",
      "- 10:00 chat — hi [X](2026-09/29-X.md)",
      "",
      "## Sessions",
      "",
      "### 10:05 · rotate · goals · `a.jsonl`",
      "",
      "### Goals",
      "- ship it",
      "",
      "### 11:00 · new · other · `b.jsonl`",
      "",
      "second recap",
      "",
      "## Later section",
      "not a session",
    ].join("\n");
    expect(splitSessions(text)).toEqual([
      { heading: "10:05 · rotate · goals · `a.jsonl`", body: "### Goals\n- ship it" },
      { heading: "11:00 · new · other · `b.jsonl`", body: "second recap" },
    ]);
    expect(splitSessions("# no sessions\n")).toEqual([]);
  });
});

describe("history/day", () => {
  test("the writer's own day: redacted recaps and the day's runs from the run index", async () => {
    const runId = ulid(T0);
    const writer = new HistoryWriter({ home, agentDir: join(root, "pi-agent"), tz: "UTC", now: () => new Date(T0) });
    writer.writeSession({ reason: "rotate", sessionFile: "/x/s1.jsonl", text: "## Goals\n- deploy\n\nnotes", at: new Date(T0) });
    appendFileSync(join(hist, "2026-09-29.md"), `\nplanted ${GH_TOKEN}\n`);
    runFile("2026-09-29", runId);
    appendFileSync(
      join(stateDir, "runs.jsonl"),
      `${JSON.stringify({ runId, agentName: "job:nightly", task: "nightly", sessionFile: "x", startedAt: new Date(T0).toISOString(), status: "failed" })}\n`,
    );
    const r = await day("2026-09-29");
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.heading).toMatch(/^10:00 · rotate · deploy · `s1\.jsonl`$/);
    expect(r.sessions[0]!.markdown).toContain("#### Goals");
    expect(JSON.stringify(r)).not.toContain(GH_TOKEN);
    expect(r.runs).toEqual([expect.objectContaining({ runId, kind: "job", status: "failed", title: "nightly" })]);
    expect(r.truncated).toBe(false);
  });

  test("a run missing from the index comes from its file header; a day with nothing is not found", async () => {
    const runId = ulid(T0);
    runFile("2026-09-29", runId, "timeout", "subagent", "coder");
    const r = await day("2026-09-29");
    expect(r.sessions).toEqual([]);
    expect(r.runs).toEqual([expect.objectContaining({ runId, kind: "subagent", agentName: "coder", status: "timeout" })]);
    expect(await historyDay(opts, { principalId: "owner", date: "2026-09-28" })).toEqual({ found: false });
  });

  test("a file larger than the cap is read in part and marked truncated", async () => {
    daily("2026-09-29", `## Sessions\n\n### 10:00 · new · t · \`a.jsonl\`\n\n${"word ".repeat(HISTORY_FILE_MAX / 4)}`);
    const r = await day("2026-09-29");
    expect(r.truncated).toBe(true);
    expect(r.sessions[0]!.markdown.length).toBeLessThanOrEqual(32_000);
  });

  test("links, hardlinks, FIFOs and a symlinked month dir or root are never read", async () => {
    const secret = join(root, "secret.md");
    writeFileSync(secret, "## Sessions\n\n### 10:00 · new · SECRET_MARKER · `a.jsonl`\n\nSECRET_MARKER\n");
    symlinkSync(secret, join(hist, "2026-09-01.md"));
    linkSync(secret, join(hist, "2026-09-02.md"));
    spawnSync("mkfifo", [join(hist, "2026-09-03.md")]);
    const outside = join(root, "outside-month");
    mkdirSync(outside);
    const runId = ulid(T0);
    writeFileSync(join(outside, `04-${runId}.md`), `# job run ${runId}\n\n- **Agent:** job / SECRET_MARKER\n- **Status:** done\n`);
    symlinkSync(outside, join(hist, "2026-09"));
    const t = Date.now();
    for (const date of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
      const r = await historyDay(opts, { principalId: "owner", date });
      expect(JSON.stringify(r)).not.toContain("SECRET_MARKER");
    }
    expect(Date.now() - t).toBeLessThan(1_000);
    const days = await historyDays(opts, { principalId: "owner" });
    expect(JSON.stringify(days)).not.toContain("2026-09-04");

    rmSync(hist, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "2026-09-05.md"), "## Sessions\n\n### 10:00 · new · SECRET_MARKER · `a.jsonl`\n");
    symlinkSync(elsewhere, hist);
    expect(await historyDay(opts, { principalId: "owner", date: "2026-09-05" })).toEqual({ found: false });
    expect(await historyDays(opts, { principalId: "owner" })).toEqual({ days: [], before: null });
  });

  test("rejects a date that is not a calendar date and a foreign principal", async () => {
    await expect(historyDay(opts, { principalId: "owner", date: "2026-02-30" })).rejects.toThrow();
    await expect(historyDay(opts, { principalId: "owner", date: "../../etc" })).rejects.toThrow();
    await expect(historyDay(opts, { principalId: "x", date: "2026-09-29" })).rejects.toThrow(/principal/);
  });

  test("many large recaps stay under the response budget", async () => {
    const block = (i: number) => `### 10:${String(i % 60).padStart(2, "0")} · new · t · \`a.jsonl\`\n\n${'"'.repeat(31_000)}\n`;
    daily("2026-09-29", `## Sessions\n\n${Array.from({ length: 30 }, (_, i) => block(i)).join("\n")}`);
    const r = await day("2026-09-29");
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(1_500_000);
    expect(r.truncated).toBe(true);
    expect(r.sessions.length).toBeLessThan(30);
  });
});

describe("history/days", () => {
  test("days from daily files and run files, newest first, with counts and paging", async () => {
    daily("2026-09-29", "## Runs\n\n## Sessions\n\n### 10:00 · new · a · `a.jsonl`\n\nx\n\n### 11:00 · rotate · b · `b.jsonl`\n\ny\n");
    daily("2026-09-27", "## Runs\n");
    runFile("2026-09-29", ulid(T0));
    runFile("2026-09-28", ulid(T0 - 86_400_000));
    runFile("2026-09-28", ulid(T0 - 86_400_000 + 1));
    runFile("2026-08-31", ulid(T0 - 30 * 86_400_000));
    writeFileSync(join(hist, "notes.md"), "not a day");
    writeFileSync(join(hist, "2026-02-30.md"), "not a calendar day");
    const all = historyDaysResult.parse(await historyDays(opts, { principalId: "owner" }));
    expect(all.days).toEqual([
      { date: "2026-09-29", runs: 1, sessions: 2 },
      { date: "2026-09-28", runs: 2, sessions: 0 },
      { date: "2026-09-27", runs: 0, sessions: 0 },
      { date: "2026-08-31", runs: 1, sessions: 0 },
    ]);
    const first = await historyDays(opts, { principalId: "owner", limit: 2 });
    expect(first.before).toBe("2026-09-28");
    const second = await historyDays(opts, { principalId: "owner", limit: 2, before: first.before });
    expect(second.days.map((d) => d.date)).toEqual(["2026-09-27", "2026-08-31"]);
    expect(second.before).toBeNull();
  });

  test("no history dir yet is an empty list", async () => {
    rmSync(hist, { recursive: true });
    expect(await historyDays(opts, { principalId: "owner" })).toEqual({ days: [], before: null });
  });
});
