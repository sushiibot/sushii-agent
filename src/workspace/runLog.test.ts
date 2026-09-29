import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLog, TASK_MAX, runLogPath, tailLines, type RunRecord } from "./runLog.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-runlog-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = () => readFileSync(runLogPath(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunRecord);

describe("RunLog", () => {
  test("writes a start line and a full end line with the same runId", () => {
    const log = new RunLog(dir);
    const runId = log.startRun({ agentName: "main", task: "hello", sessionFile: "/s/chat/a.jsonl" });
    expect(runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(log.getRun(runId)?.status).toBe("running");
    log.endRun(runId, { status: "done", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }, resultSummary: "hi" });

    const [start, end] = lines();
    expect(start).toMatchObject({ runId, agentName: "main", task: "hello", sessionFile: "/s/chat/a.jsonl", status: "running" });
    expect(start.endedAt).toBeUndefined();
    expect(end).toMatchObject({ runId, agentName: "main", task: "hello", status: "done", usage: { inputTokens: 10, outputTokens: 5 }, resultSummary: "hi" });
    expect(end.usage).not.toHaveProperty("costUsd");
    expect(end.startedAt).toBe(start.startedAt);
    expect(typeof end.endedAt).toBe("string");
  });

  test("readers take the last line per runId, newest first", () => {
    const log = new RunLog(dir);
    const a = log.startRun({ agentName: "main", task: "a", sessionFile: "f" });
    const b = log.startRun({ agentName: "coder", parentRunId: a, task: "b", sessionFile: "g" });
    log.endRun(a, { status: "aborted" });
    const runs = log.listRuns();
    expect(runs.map((r) => [r.runId, r.status])).toEqual([
      [a, "aborted"],
      [b, "running"],
    ]);
    expect(log.listRuns({ agentName: "coder" }).map((r) => r.runId)).toEqual([b]);
    expect(log.listRuns({ parentRunId: a }).map((r) => r.runId)).toEqual([b]);
    expect(log.listRuns({ limit: 1 })).toHaveLength(1);
    expect(log.getRun(a)?.status).toBe("aborted");
    expect(log.getRun("nope")).toBeNull();
  });

  test("filters by since", () => {
    let now = new Date("2026-09-01T00:00:00Z");
    const log = new RunLog(dir, { now: () => now });
    log.startRun({ agentName: "main", task: "old", sessionFile: "f" });
    now = new Date("2026-09-10T00:00:00Z");
    log.startRun({ agentName: "main", task: "new", sessionFile: "f" });
    expect(log.listRuns({ since: new Date("2026-09-05T00:00:00Z") }).map((r) => r.task)).toEqual(["new"]);
  });

  test("caps task and result summary", () => {
    const log = new RunLog(dir);
    const id = log.startRun({ agentName: "main", task: "x".repeat(2000), sessionFile: "f" });
    log.endRun(id, { status: "done", resultSummary: "y".repeat(5000) });
    const rec = log.getRun(id)!;
    expect(rec.task.length).toBe(TASK_MAX);
    expect(rec.resultSummary!.length).toBe(1000);
  });

  test("a torn last line is skipped and never swallows the next record", () => {
    const log = new RunLog(dir);
    const a = log.startRun({ agentName: "main", task: "a", sessionFile: "f" });
    appendFileSync(runLogPath(dir), '{"runId":"TORN","agentName":"ma');
    expect(log.listRuns().map((r) => r.runId)).toEqual([a]);
    const b = log.startRun({ agentName: "main", task: "b", sessionFile: "f" });
    log.endRun(a, { status: "done" });
    expect(log.listRuns().map((r) => [r.runId, r.status])).toEqual([
      [a, "done"],
      [b, "running"],
    ]);
  });

  test("ends a run started by an earlier process", () => {
    const first = new RunLog(dir);
    const id = first.startRun({ agentName: "job:daily", task: "t", sessionFile: "f" });
    new RunLog(dir).endRun(id, { status: "timeout" });
    expect(new RunLog(dir).getRun(id)).toMatchObject({ status: "timeout", agentName: "job:daily", task: "t" });
    expect(() => new RunLog(dir).endRun("missing", { status: "done" })).toThrow("unknown runId");
  });

  test("reconcileOrphans closes runs a dead process left running, but not live ones", () => {
    const dead = new RunLog(dir);
    const orphan = dead.startRun({ agentName: "main", task: "o", sessionFile: "f" });
    const live = new RunLog(dir);
    const mine = live.startRun({ agentName: "main", task: "m", sessionFile: "f" });
    expect(live.reconcileOrphans()).toBe(1);
    expect(live.getRun(orphan)?.status).toBe("failed");
    expect(live.getRun(mine)?.status).toBe("running");
    expect(live.reconcileOrphans()).toBe(0);
  });

  test("tailLines reads backwards across chunk boundaries", () => {
    const path = join(dir, "x.jsonl");
    const want = Array.from({ length: 50 }, (_, i) => `line-${i}-${"z".repeat(i)}`);
    writeFileSync(path, `${want.join("\n")}\n`);
    expect([...tailLines(path, 7)]).toEqual([...want].reverse());
    expect([...tailLines(join(dir, "missing"))]).toEqual([]);
  });
});
