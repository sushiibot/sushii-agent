import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelCosts } from "./modelCosts.ts";
import { RUN_SCAN_MAX_LINES } from "./runReader.ts";
import type { RunRecord } from "./runLog.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "model-costs-"));
  dirs.push(stateDir);
  const path = join(stateDir, "runs.jsonl");
  const record = (runId: string, fields: Partial<RunRecord> = {}) => {
    const run: RunRecord = { runId, agentName: "main", task: "test", sessionFile: "current.jsonl", startedAt: "2026-10-01T07:15:00Z", status: "done", ...fields };
    appendFileSync(path, `${JSON.stringify(run)}\n`);
  };
  const read = (sessionFile: string | null = "current.jsonl") => readModelCosts({ stateDir, timeZone: "America/Los_Angeles", now: new Date("2026-10-01T16:00:00Z"), sessionFile });
  return { record, read, path };
}
const usage = (costUsd?: number) => ({ inputTokens: 100, outputTokens: 20, ...(costUsd === undefined ? {} : { costUsd }) });

test("session includes current file across days plus nested delegates once; today spans all conversations", async () => {
  const { record, read } = setup();
  record("parent", { usage: usage(0.1) });
  record("child", { agentName: "coder", sessionFile: "child.jsonl", parentRunId: "parent", usage: usage(0.2) });
  record("grandchild", { agentName: "researcher", sessionFile: "grandchild.jsonl", parentRunId: "child", usage: usage(0.3) });
  record("last-night", { startedAt: "2026-10-01T06:59:00Z", usage: usage(0.4) });
  record("older-session", { sessionFile: "retired.jsonl", usage: usage(0.5) });
  record("topic", { agentName: "topic:ux", sessionFile: "topic.jsonl", conversationId: "ux", usage: usage(0.6) });
  record("parent", { usage: usage(0.15) });
  record("rotation", { agentName: "main:rotate", sessionFile: "retired.jsonl" });
  const cost = await read();
  expect(cost.session?.usd).toBeCloseTo(1.05);
  expect(cost.session).toMatchObject({ recordedRuns: 4, unpricedRuns: 0 });
  expect(cost.today.usd).toBeCloseTo(1.75);
  expect(cost.today).toMatchObject({ recordedRuns: 5, unpricedRuns: 0 });
  expect(cost).toMatchObject({ date: "2026-10-01", timeZone: "America/Los_Angeles" });
  expect((await read("topic.jsonl")).session).toEqual({ usd: 0.6, recordedRuns: 1, unpricedRuns: 0 });
});

test("subscription, running and absent pricing remain unpriced rather than invented zero; no session remains unknown", async () => {
  const { record, read } = setup();
  record("subscription", { usage: { ...usage(), model: "chatgpt/gpt-6.1-sol" } });
  record("pending", { status: "running" });
  record("paid", { usage: usage(0.2) });
  record("negative", { usage: usage(-1) });
  record("bad-date", { startedAt: "invalid", sessionFile: "other.jsonl", usage: usage(10) });
  expect((await read()).session).toEqual({ usd: 0.2, recordedRuns: 1, unpricedRuns: 3 });
  expect((await read()).today).toEqual({ usd: 0.2, recordedRuns: 1, unpricedRuns: 3 });
  expect(await read(null)).not.toHaveProperty("session");
  expect((await read("fresh.jsonl")).session).toEqual({ usd: 0, recordedRuns: 0, unpricedRuns: 0 });
});

test("fresh workspace has known empty totals and bounded scans disclose incompleteness", async () => {
  const { path, read } = setup();
  expect((await read()).today).toEqual({ usd: 0, recordedRuns: 0, unpricedRuns: 0 });
  writeFileSync(path, "{}\n".repeat(RUN_SCAN_MAX_LINES + 1));
  expect((await read()).truncated).toBe(true);
});
