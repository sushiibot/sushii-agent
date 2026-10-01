import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_METHODS, runsGetResult, runsListResult, type RunsGetResult } from "../orchestration/contracts.ts";
import { FLUSH_MARKER } from "./memoryFlush.ts";
import { RunLog, type RunRecord, type RunRecorder } from "./runLog.ts";
import { notifyRunChanges, runsGet, runsList, type RunsRpcOptions } from "./runsRpc.ts";
import { ulid } from "./ulid.ts";
import { VERIFY_CUSTOM_TYPE } from "./verifyGate.ts";

const GH_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
const T0 = Date.parse("2026-09-29T10:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const ids = new Map<number, string>();
const id = (s: number) => ids.get(s) ?? ids.set(s, ulid(T0 + s * 1000)).get(s)!;

let root: string;
let home: string;
let agentDir: string;
let stateDir: string;
let opts: RunsRpcOptions;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-runsrpc-"));
  home = join(root, "home");
  agentDir = join(root, "pi-agent");
  stateDir = join(root, ".workspace");
  for (const d of [home, join(agentDir, "chat"), join(agentDir, "job-sessions"), join(agentDir, "subagents"), stateDir]) mkdirSync(d, { recursive: true });
  opts = { principalId: "owner", stateDir, home, tz: "UTC", agentDirs: [agentDir], now: () => new Date(T0 + 3600_000) };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const runsFile = () => join(stateDir, "runs.jsonl");
function record(r: Partial<RunRecord> & { runId: string }): void {
  const full = { agentName: "main", task: "a task", sessionFile: join(agentDir, "chat", "s.jsonl"), startedAt: iso(0), status: "done", ...r };
  appendFileSync(runsFile(), `${JSON.stringify(full)}\n`);
}

const msg = (eid: string, s: number, message: object) => ({ type: "message", id: eid, parentId: null, timestamp: iso(s), message });
function session(file: string, entries: object[]): void {
  const header = { type: "session", version: 3, id: "s1", timestamp: iso(-100), cwd: home };
  writeFileSync(file, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
}

const list = (p: object = {}) => runsList(opts, { principalId: "owner", ...p });
async function get(runId: string, p: object = {}): Promise<Extract<RunsGetResult, { found: true }>> {
  const r = await runsGet(opts, { principalId: "owner", runId, ...p });
  runsGetResult.parse(r);
  if (!r.found) throw new Error("run not found");
  return r;
}

describe("runs/list", () => {
  test("latest record per run, newest first, redacted one-line titles with the chat header stripped", async () => {
    const a = id(1);
    const b = id(2);
    record({ runId: a, status: "running", task: `[web:owner 2026-09-29 10:00 UTC]\ndeploy with ${GH_TOKEN}\nplease` });
    record({ runId: b, agentName: "job:nightly", task: "nightly job", status: "running" });
    record({ runId: a, status: "done", task: "[web:owner 2026-09-29 10:00 UTC]\ndeploy", endedAt: iso(5), usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, model: "m" }, resultSummary: `ok ${GH_TOKEN}`, turnId: "turn-1" });
    const r = runsListResult.parse(await list());
    expect(r.runs.map((x) => [x.runId, x.kind, x.status])).toEqual([
      [b, "job", "running"],
      [a, "chat", "done"],
    ]);
    expect(r.runs[0]).toMatchObject({ jobName: "nightly", title: "nightly job" });
    expect(r.runs[1]).toMatchObject({ title: "deploy", turnId: "turn-1", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, model: "m" } });
    expect(r.runs[1]!.resultSummary).not.toContain(GH_TOKEN);
    expect(r).toMatchObject({ before: null, truncated: false });
  });

  test("kinds: flush, rotate, subagent, agent", async () => {
    const parent = id(1);
    record({ runId: parent });
    record({ runId: id(2), task: `${FLUSH_MARKER} write memory` });
    record({ runId: id(3), agentName: "main:rotate", task: "idle rotation" });
    record({ runId: id(4), agentName: "coder", parentRunId: parent });
    record({ runId: id(5), agentName: "coder" });
    const r = await list();
    expect(r.runs.map((x) => x.kind)).toEqual(["agent", "subagent", "rotate", "flush", "chat"]);
    expect(r.runs.find((x) => x.kind === "flush")!.title).toBe("memory flush");
    expect((await list({ kinds: ["subagent", "agent"] })).runs.map((x) => x.kind)).toEqual(["agent", "subagent"]);
  });

  test("filters by status and start time, and pages with `before`", async () => {
    for (let i = 1; i <= 7; i++) record({ runId: id(i * 60), startedAt: iso(i * 60), status: i % 2 ? "done" : "failed" });
    expect((await list({ statuses: ["failed"] })).runs).toHaveLength(3);
    expect((await list({ since: iso(180), until: iso(360) })).runs.map((x) => x.startedAt)).toEqual([iso(300), iso(240), iso(180)]);
    const first = await list({ limit: 3 });
    expect(first.runs).toHaveLength(3);
    expect(first.before).toBe(first.runs[2]!.runId);
    const second = await list({ limit: 3, before: first.before });
    expect(second.runs[0]!.runId < first.before!).toBe(true);
    const third = await list({ limit: 3, before: second.before });
    expect(third.runs).toHaveLength(1);
    expect(third.before).toBeNull();
  });

  test("garbled and forged records are dropped one by one, never the page", async () => {
    const good = id(1);
    record({ runId: good });
    appendFileSync(runsFile(), "not json\n{\"runId\":\n");
    record({ runId: "../../etc/passwd" });
    record({ runId: id(2), status: "pwned" as RunRecord["status"] });
    record({ runId: id(3), agentName: 42 as unknown as string });
    record({ runId: id(4), startedAt: "x".repeat(100) });
    record({ runId: id(5), parentRunId: "not-a-run", agentName: "coder", usage: { inputTokens: -1, outputTokens: 2 } });
    appendFileSync(runsFile(), `${JSON.stringify({ runId: id(6), status: "done", startedAt: iso(6), agentName: "main", task: "x".repeat(100_000) })}\n`);
    const r = runsListResult.parse(await list());
    expect(r.runs.map((x) => x.runId)).toEqual([id(5), good]);
    expect(r.runs[0]).not.toHaveProperty("parentRunId");
    expect(r.runs[0]).not.toHaveProperty("usage");
    expect(r.runs[0]!.kind).toBe("agent");
  });

  test("the scan stops at 20,000 lines and says older runs exist", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 20_005; i++) lines.push(JSON.stringify({ runId: ulid(T0 + i), agentName: "main", task: "t", sessionFile: "x", startedAt: iso(0), status: "done" }));
    writeFileSync(runsFile(), `${lines.join("\n")}\n`);
    const r = await list({ limit: 50 });
    expect(r.truncated).toBe(true);
    expect(r.runs).toHaveLength(50);
  });

  test("a runs.jsonl that is a FIFO, a symlink or a hardlink reads as empty, without hanging", async () => {
    spawnSync("mkfifo", [runsFile()]);
    const t = Date.now();
    expect((await list()).runs).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1_000);
    rmSync(runsFile());
    const elsewhere = join(root, "elsewhere.jsonl");
    writeFileSync(elsewhere, `${JSON.stringify({ runId: id(1), agentName: "main", task: "t", sessionFile: "x", startedAt: iso(0), status: "done" })}\n`);
    symlinkSync(elsewhere, runsFile());
    expect((await list()).runs).toEqual([]);
    rmSync(runsFile());
    linkSync(elsewhere, runsFile());
    expect((await list()).runs).toEqual([]);
  });

  test("checks the principal", async () => {
    await expect(runsList(opts, { principalId: "someone-else" })).rejects.toThrow(/principal/);
  });
});

describe("runs/get", () => {
  const chat = () => join(agentDir, "chat", "s.jsonl");

  function mainRun(runId: string, extra: Partial<RunRecord> = {}): void {
    session(chat(), [
      msg("e0", -50, { role: "user", content: "an earlier run" }),
      msg("e1", 1, { role: "user", content: [{ type: "text", text: "[web:owner]\nfix the build" }, { type: "image", data: "AAAA".repeat(1000), mimeType: "image/png" }] }),
      msg("e2", 2, {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: `On it, token ${GH_TOKEN}` },
          { type: "toolCall", id: "c1", name: "edit", arguments: { path: "projects/app/src/x.ts", oldText: "a", newText: "b" } },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "cd projects/app && bun test" } },
          { type: "toolCall", id: "c3", name: "write", arguments: { path: "~/MEMORY.md", content: "notes" } },
          { type: "toolCall", id: "c4", name: "bash", arguments: { command: "echo hi >> USER.md" } },
          { type: "toolCall", id: "c5", name: "bash", arguments: { command: "cat MEMORY.md" } },
          { type: "toolCall", id: "c6", name: "send_file", arguments: { path: "/data/home/report.pdf" } },
          { type: "toolCall", id: "c7", name: "delegate", arguments: { agent: "coder", task: "x" } },
          { type: "toolCall", id: "c8", name: "bash", arguments: { command: "sleep 100" } },
        ],
        stopReason: "toolUse",
      }),
      msg("e3", 3, { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "edited" }], isError: false }),
      msg("e4", 5, { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: `1 fail ${GH_TOKEN}` }], isError: true }),
      msg("e5", 5, { role: "toolResult", toolCallId: "c3", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false }),
      msg("e6", 5, { role: "toolResult", toolCallId: "c4", toolName: "bash", content: [{ type: "text", text: "" }], isError: false }),
      msg("e7", 5, { role: "toolResult", toolCallId: "c5", toolName: "bash", content: [{ type: "text", text: "..." }], isError: false }),
      msg("e8", 5, { role: "toolResult", toolCallId: "c6", toolName: "send_file", content: [{ type: "text", text: "attached" }], isError: false }),
      msg("e9", 6, { role: "toolResult", toolCallId: "c7", toolName: "delegate", content: [{ type: "text", text: "child done" }], isError: false, details: { runId: id(4) } }),
      { type: "custom_message", id: "e10", timestamp: iso(7), customType: VERIFY_CUSTOM_TYPE, content: "run the check", display: false },
      { type: "compaction", id: "e11", timestamp: iso(8), summary: "summary text" },
      msg("e12", 9, { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "provider blew up" }),
      msg("e13", 10, { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }),
      msg("e14", 200, { role: "user", content: "a later run" }),
    ]);
    record({ runId, sessionFile: chat(), startedAt: iso(0), endedAt: iso(11), turnId: "turn-9", ...extra });
  }

  test("the run's window of its session as typed steps, redacted, with tool results paired", async () => {
    const runId = id(0);
    mainRun(runId);
    const r = await get(runId);
    expect(r.session).toBe("ok");
    expect(r.run.turnId).toBe("turn-9");
    expect(r.steps.map((s) => `${s.type}:${s.id}`)).toEqual([
      "user:e1",
      "assistant:e2",
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `tool:e2/t${k}`),
      "note:e10",
      "note:e11",
      "note:e12/stop",
      "assistant:e13",
    ]);
    const json = JSON.stringify(r);
    expect(json).not.toContain(GH_TOKEN);
    expect(json).not.toContain("AAAA");
    expect(json).not.toContain("private");
    expect(json).not.toContain("an earlier run");
    expect(json).not.toContain("a later run");
    const tool = (k: number) => r.steps.find((s) => s.id === `e2/t${k}`) as Extract<RunsGetResult, { found: true }>["steps"][number] & { type: "tool" };
    expect(tool(0)).toMatchObject({ name: "edit", ok: true, result: "edited", durationMs: 1000 });
    expect(tool(1)).toMatchObject({ name: "bash", ok: false, durationMs: 3000 });
    expect(tool(6)).toMatchObject({ agentId: id(4) });
    expect(tool(7)).toMatchObject({ ok: null, result: "" });
    expect(r.steps.filter((s) => s.type === "note").map((s) => (s as { kind: string }).kind)).toEqual(["verify", "compaction", "error"]);
  });

  test("evidence: checks, changed repos, verify nudge, files sent and memory writes", async () => {
    const runId = id(0);
    mainRun(runId);
    const { evidence } = await get(runId);
    expect(evidence).toEqual({
      checks: [{ command: "cd projects/app && bun test", ok: false, at: iso(2) }],
      changedRepos: ["app"],
      checkAfterLastChange: true,
      verifyNudged: true,
      filesSent: [{ name: "report.pdf", at: iso(2) }],
      memoryWrites: [
        { path: "MEMORY.md", tool: "write", at: iso(2) },
        { path: "USER.md", tool: "bash", at: iso(2) },
      ],
    });
  });

  test("pages steps with `after`; evidence only on the first page; an unknown cursor is refused", async () => {
    const runId = id(0);
    mainRun(runId);
    const all = (await get(runId)).steps.map((s) => s.id);
    const first = await get(runId, { limit: 5 });
    expect(first.steps.map((s) => s.id)).toEqual(all.slice(0, 5));
    expect(first.after).toBe(all[4]!);
    const second = await get(runId, { limit: 50, after: first.after });
    expect(second.steps.map((s) => s.id)).toEqual(all.slice(5));
    expect(second.after).toBeNull();
    expect(second.evidence).toBeUndefined();
    await expect(runsGet(opts, { principalId: "owner", runId, after: "nope" })).rejects.toThrow(/cursor/);
  });

  test("ids of entries without a usable id stay stable while a running run appends", async () => {
    const runId = id(0);
    session(chat(), [
      { type: "message", timestamp: iso(1), message: { role: "user", content: "no id" } },
      msg("dup", 2, { role: "assistant", content: [{ type: "text", text: "one" }], stopReason: "stop" }),
      msg("dup", 3, { role: "assistant", content: [{ type: "text", text: "two" }], stopReason: "stop" }),
    ]);
    record({ runId, sessionFile: chat(), status: "running" });
    const first = await get(runId, { limit: 2 });
    expect(first.steps.map((s) => s.id)).toEqual(["#0", "dup"]);
    appendFileSync(chat(), `${JSON.stringify({ type: "message", timestamp: iso(4), message: { role: "user", content: "later, no id" } })}\n`);
    const next = await get(runId, { after: first.after });
    expect(next.steps.map((s) => s.id)).toEqual(["#2", "#3"]);
  });

  test("session states: missing, outside, not-session; never read past the roots", async () => {
    const secret = join(root, "outside.jsonl");
    session(secret, [msg("x1", 1, { role: "user", content: "OUTSIDE_MARKER" })]);
    const cases: [string, string][] = [];
    const add = (sessionFile: string, want: string) => {
      const runId = id(cases.length + 1);
      record({ runId, sessionFile });
      cases.push([runId, want]);
    };
    add(join(agentDir, "chat", "gone.jsonl"), "missing");
    add(secret, "outside");
    const link = join(agentDir, "chat", "link.jsonl");
    symlinkSync(secret, link);
    add(link, "outside");
    const hard = join(agentDir, "chat", "hard.jsonl");
    linkSync(secret, hard);
    add(hard, "not-session");
    const notSession = join(agentDir, "chat", "plain.jsonl");
    writeFileSync(notSession, `${JSON.stringify(msg("x2", 1, { role: "user", content: "OUTSIDE_MARKER" }))}\n`);
    add(notSession, "not-session");
    const fifo = join(agentDir, "chat", "fifo.jsonl");
    spawnSync("mkfifo", [fifo]);
    add(fifo, "not-session");
    const hugeHeader = join(agentDir, "chat", "huge.jsonl");
    writeFileSync(hugeHeader, "x".repeat(200_000));
    add(hugeHeader, "not-session");
    add(42 as unknown as string, "missing");
    const t = Date.now();
    for (const [runId, want] of cases) {
      const r = await get(runId);
      expect([runId, r.session]).toEqual([runId, want]);
      expect(r.steps).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("OUTSIDE_MARKER");
    }
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  test("parent, children and the history file link", async () => {
    const parent = id(0);
    mainRun(parent);
    const c1 = id(2);
    const c2 = id(3);
    record({ runId: c2, agentName: "coder", parentRunId: parent, sessionFile: "x" });
    record({ runId: c1, agentName: "explore", parentRunId: parent, sessionFile: "x" });
    mkdirSync(join(home, "history", "2026-09"), { recursive: true });
    writeFileSync(join(home, "history", "2026-09", `29-${parent}.md`), "# chat run\n");
    const r = await get(parent);
    expect(r.children.map((c) => c.runId)).toEqual([c1, c2]);
    expect(r.historyFile).toBe(`2026-09/29-${parent}.md`);
    const child = await get(c1);
    expect(child.parent?.runId).toBe(parent);
    expect(child.run.kind).toBe("subagent");
  });

  test("a run past the index opens from its history file header; an unknown run is not found", async () => {
    const old = id(-86_400 * 3);
    mkdirSync(join(home, "history", "2026-09"), { recursive: true });
    writeFileSync(
      join(home, "history", "2026-09", `26-${old}.md`),
      `# job run ${old}\n\n- **When:** 2026-09-26 10:00 → 10:01 (UTC)\n- **Agent:** job / job:nightly\n- **Status:** failed\n\n## Transcript\n`,
    );
    const r = await get(old);
    expect(r.run).toMatchObject({ runId: old, kind: "job", agentName: "job:nightly", jobName: "nightly", status: "failed", startedAt: new Date(T0 - 86_400_000 * 3).toISOString() });
    expect(r).toMatchObject({ session: "missing", steps: [], historyFile: `2026-09/26-${old}.md` });
    expect(await runsGet(opts, { principalId: "owner", runId: id(99) })).toEqual({ found: false });
  });

  test("huge and hostile texts stay inside the caps and the response budget, quickly", async () => {
    const runId = id(0);
    const entries: object[] = [msg("u", 1, { role: "user", content: "a".repeat(2_000_000) })];
    for (let i = 0; i < 199; i++) entries.push(msg(`a${i}`, 2, { role: "assistant", content: [{ type: "text", text: `${String.fromCharCode(1).repeat(50)}${'"'.repeat(9_000)}` }], stopReason: "stop" }));
    session(chat(), entries);
    record({ runId, sessionFile: chat(), endedAt: iso(3) });
    const t = Date.now();
    const r = await get(runId, { limit: 200 });
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(1_500_000);
    expect(r.steps[0]!.type === "user" && r.steps[0]!.text.length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(r)).not.toContain("\\u0001");
    expect(r.steps.length).toBeLessThan(200);
    expect(r.after).toBe(r.steps.at(-1)!.id);
  });
});

describe("runs/get response size", () => {
  test("huge tool outputs, args and child titles: every page stays under 1.5 MB and the pages cover every step", async () => {
    const runId = id(0);
    const chatFile = join(agentDir, "chat", "big.jsonl");
    const heavy = `${'"'.repeat(30_000)}${"€".repeat(10_000)}${"😀".repeat(5_000)}`;
    const entries: object[] = [];
    // ~40 MiB of transcript: under the 64 MiB session read cap, so every step is reachable.
    for (let i = 0; i < 120; i++) {
      entries.push(msg(`a${i}`, 1, { role: "assistant", content: [{ type: "text", text: heavy }, { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: heavy } }], stopReason: "toolUse" }));
      entries.push(msg(`r${i}`, 2, { role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: heavy }], isError: false }));
    }
    session(chatFile, entries);
    // A record line is a few KiB at most (the host clips task and result); these fill each field past its wire cap.
    const field = `${'"'.repeat(600)}${"€".repeat(600)}`;
    record({ runId, sessionFile: chatFile, endedAt: iso(3), task: field, resultSummary: field });
    for (let i = 0; i < 60; i++) record({ runId: id(10 + i), agentName: field, parentRunId: runId, task: field, resultSummary: field, sessionFile: "x" });
    const seen: string[] = [];
    let after: string | null | undefined;
    do {
      const r = await runsGet(opts, { principalId: "owner", runId, limit: 200, ...(after ? { after } : {}) });
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(1_500_000);
      if (!r.found) throw new Error("not found");
      seen.push(...r.steps.map((s) => s.id));
      after = r.after;
    } while (after);
    expect(seen).toHaveLength(240);
    expect(new Set(seen).size).toBe(240);
  });
});

describe("runs/get past the session read cap", () => {
  test("a window larger than the read cap starts with a note saying its start isn't shown", async () => {
    const runId = id(0);
    const file = join(agentDir, "chat", "huge.jsonl");
    const big = "word ".repeat(2_000_000);
    const lines = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: iso(-1), cwd: home })];
    for (let i = 0; i < 8; i++) lines.push(JSON.stringify(msg(`u${i}`, 1, { role: "user", content: big })));
    lines.push(JSON.stringify(msg("last", 2, { role: "assistant", content: [{ type: "text", text: "the end" }], stopReason: "stop" })));
    writeFileSync(file, `${lines.join("\n")}\n`);
    record({ runId, sessionFile: file, endedAt: iso(3) });
    const r = await get(runId);
    expect(r.steps[0]).toMatchObject({ type: "note", id: "#head", kind: "custom" });
    expect(r.steps.at(-1)).toMatchObject({ type: "assistant", text: "the end" });
    expect(r.steps.length).toBeLessThan(10);
  });
});

describe("runs/get and the event loop", () => {
  test("a ~20 MiB window with hostile commands never blocks the loop for long", async () => {
    const runId = id(0);
    const file = join(agentDir, "chat", "long.jsonl");
    const command = "sed ".repeat(500);
    const result = "0123456789abcdef".repeat(128);
    const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: iso(-1), cwd: home })];
    for (let i = 0; i < 4_500; i++) {
      lines.push(JSON.stringify(msg(`a${i}`, 1, { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command } }], stopReason: "toolUse" })));
      lines.push(JSON.stringify(msg(`r${i}`, 2, { role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: result }], isError: false })));
    }
    writeFileSync(file, `${lines.join("\n")}\n`);
    record({ runId, sessionFile: file, endedAt: iso(3) });
    let last = performance.now();
    let gap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
    }, 5);
    try {
      const r = await get(runId, { limit: 200 });
      expect(r.steps).toHaveLength(200);
      expect(r.evidence?.checks).toEqual([]);
    } finally {
      clearInterval(timer);
    }
    expect(gap).toBeLessThan(200);
  });
});

describe("runs/changed", () => {
  function recorder() {
    const sent: unknown[] = [];
    const inner = new RunLog(stateDir);
    return { sent, inner };
  }

  test("background runs notify on start and end; chat turns don't", () => {
    const { sent, inner } = recorder();
    const runs = notifyRunChanges(inner, (method, params) => sent.push({ method, params }), "owner");
    const chat = runs.startRun({ agentName: "main", task: "hi", sessionFile: "x" });
    runs.endRun(chat, { status: "done" });
    const job = runs.startRun({ agentName: "job:nightly", task: "n", sessionFile: "x" });
    const child = runs.startRun({ agentName: "coder", parentRunId: job, task: "c", sessionFile: "x" });
    runs.endRun(child, { status: "failed" });
    runs.endRun(job, { status: "done" });
    expect(sent).toEqual([
      { method: RPC_METHODS.runsChanged, params: { principalId: "owner", runId: job, kind: "job", status: "running", jobName: "nightly" } },
      { method: RPC_METHODS.runsChanged, params: { principalId: "owner", runId: child, kind: "subagent", status: "running", parentRunId: job } },
      { method: RPC_METHODS.runsChanged, params: { principalId: "owner", runId: child, kind: "subagent", status: "failed", parentRunId: job } },
      { method: RPC_METHODS.runsChanged, params: { principalId: "owner", runId: job, kind: "job", status: "done", jobName: "nightly" } },
    ]);
  });

  test("a failing notify never fails the run log", () => {
    const { inner } = recorder();
    const runs: RunRecorder = notifyRunChanges(inner, () => {
      throw new Error("link closed");
    }, "owner");
    const job = runs.startRun({ agentName: "job:x", task: "n", sessionFile: "x" });
    expect(() => runs.endRun(job, { status: "done" })).not.toThrow();
    expect(inner.getRun(job)?.status).toBe("done");
  });
});
