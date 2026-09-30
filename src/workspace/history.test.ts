import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerGit } from "../agentRuntime/runnerGit.ts";
import { HistoryWriter, recordHistory, summaryTopic } from "./history.ts";
import { scaffoldHome } from "./home.ts";
import { RunLog } from "./runLog.ts";
import { subagentSessionDir } from "./sessionPaths.ts";

const GH_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
const LONG_ARG = `echo ${"x".repeat(300)}`;

let root: string;
let home: string;
let agentDir: string;
let stateDir: string;
let clock: Date;
const warnings: Array<{ obj: object; msg: string }> = [];
const log = { warn: (obj: object, msg: string) => warnings.push({ obj, msg }) };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-history-"));
  home = join(root, "home");
  agentDir = join(root, "pi-agent");
  stateDir = join(root, ".workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(agentDir, "chat"), { recursive: true });
  warnings.length = 0;
  clock = new Date("2026-09-29T10:00:00Z");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const msg = (id: string, ts: string, message: object) => ({ type: "message", id, parentId: null, timestamp: ts, message });

function writeSession(file: string, entries: object[]): void {
  const header = { type: "session", version: 3, id: "s1", timestamp: "2026-09-29T09:00:00.000Z", cwd: home };
  writeFileSync(file, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function setup() {
  const writer = new HistoryWriter({ home, agentDir, tz: "UTC" });
  const runs = recordHistory(new RunLog(stateDir), writer, log, () => clock);
  return { writer, runs };
}

const chatFile = () => join(agentDir, "chat", "2026-09-29_s1.jsonl");

function mainSession(): void {
  writeSession(chatFile(), [
    msg("e0", "2026-09-29T09:30:00.000Z", { role: "user", content: "an older run about zebras" }),
    msg("e1", "2026-09-29T10:00:01.000Z", { role: "user", content: [{ type: "text", text: "[discord:111 2026-09-29 10:00 UTC]\ndeploy the thing please" }] }),
    msg("e2", "2026-09-29T10:00:02.000Z", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private thoughts" },
        { type: "text", text: "On it." },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: `GH=${GH_TOKEN} gh pr list` } },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: LONG_ARG } },
      ],
      stopReason: "toolUse",
    }),
    msg("e3", "2026-09-29T10:00:03.000Z", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: `token ${GH_TOKEN}\nsecond line` }], isError: false }),
    msg("e4", "2026-09-29T10:00:04.000Z", { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "boom: not found" }], isError: true }),
    msg("e5", "2026-09-29T10:00:05.000Z", { role: "assistant", content: [{ type: "text", text: `Done. Used ${GH_TOKEN}.` }], stopReason: "stop" }),
  ]);
}

describe("run history files", () => {
  test("a run writes a redacted markdown transcript with one line per tool call, plus a daily index line", () => {
    mainSession();
    const { runs } = setup();
    const runId = runs.startRun({ agentName: "main", task: "[discord:111 2026-09-29 10:00 UTC]\ndeploy the thing please", sessionFile: chatFile() });
    clock = new Date("2026-09-29T10:00:06Z");
    runs.endRun(runId, { status: "done", usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.0123, model: "chatgpt/gpt-5.5" } });

    const file = join(home, "history", "2026-09", `29-${runId}.md`);
    const md = readFileSync(file, "utf8");
    expect(md).not.toContain(GH_TOKEN);
    expect(md).not.toContain("private thoughts");
    expect(md).not.toContain("zebras");
    expect(md).not.toContain("second line");
    expect(md).toContain("- **When:** 2026-09-29 10:00 → 10:00 (UTC)");
    expect(md).toContain("- **Origin:** discord:111");
    expect(md).toContain("- **Model:** chatgpt/gpt-5.5 · 1200 in / 80 out · $0.0123");
    expect(md).toContain("- **Status:** done");
    expect(md).toContain("### user · 10:00\n\n[discord:111 2026-09-29 10:00 UTC]\ndeploy the thing please\n");
    expect(md).toContain("Done. Used [REDACTED].");
    const toolLines = md.split("\n").filter((l) => l.startsWith("- `bash`"));
    expect(toolLines).toHaveLength(2);
    expect(toolLines[0]).toBe('- `bash` {"command":"GH=[REDACTED] gh pr list"} → ok: token [REDACTED]');
    expect(toolLines[1]).toContain("→ error: boom: not found");
    expect(toolLines[1]!.length).toBeLessThan(200);

    const daily = readFileSync(join(home, "history", "2026-09-29.md"), "utf8");
    expect(daily).toBe(`# 2026-09-29\n\n## Runs\n\n- 10:00 chat — deploy the thing please (2 tools, done) [${runId}](2026-09/29-${runId}.md)\n\n## Sessions\n`);
  });

  test("a subagent run links to its parent and the parent lists it; run lines stay above the sessions", () => {
    mainSession();
    const { runs, writer } = setup();
    const parent = runs.startRun({ agentName: "main", task: "deploy", sessionFile: chatFile() });
    clock = new Date("2026-09-29T10:00:02Z");
    const childDir = subagentSessionDir(agentDir, parent);
    mkdirSync(childDir, { recursive: true });
    const childFile = join(childDir, "child.jsonl");
    writeSession(childFile, [
      msg("c1", "2026-09-29T10:00:02.500Z", { role: "user", content: "find the failing test" }),
      msg("c2", "2026-09-29T10:00:03.000Z", { role: "assistant", content: [{ type: "text", text: "it's foo.test.ts" }], stopReason: "stop" }),
    ]);
    const child = runs.startRun({ agentName: "explore", parentRunId: parent, task: "find the failing test", sessionFile: childFile });
    clock = new Date("2026-09-29T10:00:04Z");
    runs.endRun(child, { status: "done" });
    writer.writeSession({ reason: "rotate", sessionFile: "/x/chat/old.jsonl", text: "## Goals\n- ship it", at: new Date("2026-09-29T10:00:04Z") });
    clock = new Date("2026-09-29T10:00:06Z");
    runs.endRun(parent, { status: "done" });

    const childMd = readFileSync(join(home, "history", "2026-09", `29-${child}.md`), "utf8");
    expect(childMd).toContain(`- **Parent:** [${parent}](29-${parent}.md)`);
    expect(childMd).toContain("it's foo.test.ts");
    const parentMd = readFileSync(join(home, "history", "2026-09", `29-${parent}.md`), "utf8");
    expect(parentMd).toContain(`- **Subagent:** [explore ${child}](29-${child}.md) (done)`);

    const daily = readFileSync(join(home, "history", "2026-09-29.md"), "utf8");
    const [runsPart, sessionsPart] = daily.split("## Sessions");
    expect(runsPart).toContain(`subagent/explore — find the failing test (0 tools, done) [${child}]`);
    expect(runsPart).toContain(`- 10:00 chat — deploy the thing please (2 tools, done) [${parent}]`);
    expect(sessionsPart).toBe("\n\n### 10:00 · rotate · ship it · `old.jsonl`\n\n#### Goals\n- ship it\n");
  });

  test("a session file outside the agent's session dirs is never read", () => {
    const outside = join(root, "secret.jsonl");
    writeSession(outside, [msg("e1", "2026-09-29T10:00:01.000Z", { role: "user", content: "OUTSIDE_MARKER" })]);
    const { runs } = setup();
    const runId = runs.startRun({ agentName: "job:heartbeat", task: "check in", sessionFile: outside });
    clock = new Date("2026-09-29T10:00:06Z");
    runs.endRun(runId, { status: "done" });
    const md = readFileSync(join(home, "history", "2026-09", `29-${runId}.md`), "utf8");
    expect(md).not.toContain("OUTSIDE_MARKER");
    expect(md).toContain("_(no session file for this run)_");
    expect(readFileSync(join(home, "history", "2026-09-29.md"), "utf8")).toContain("job/job:heartbeat — check in (0 tools, done)");
  });

  test("rotation bookkeeping runs get no history file", () => {
    const { runs } = setup();
    const runId = runs.startRun({ agentName: "main:rotate", task: "idle rotation", sessionFile: chatFile() });
    runs.endRun(runId, { status: "done" });
    expect(existsSync(join(home, "history"))).toBe(false);
  });

  test("a failing write is logged and swallowed; the run log still records the end", () => {
    mainSession();
    writeFileSync(join(home, "history"), "not a dir");
    const { runs } = setup();
    const runId = runs.startRun({ agentName: "main", task: "hi", sessionFile: chatFile() });
    expect(() => runs.endRun(runId, { status: "done" })).not.toThrow();
    expect(runs.getRun(runId)?.status).toBe("done");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toBe("failed to write the run's history file");
  });

  test("session summaries are redacted and their topic comes from the Goals section", () => {
    const { writer } = setup();
    writer.writeSession({ reason: "new", sessionFile: "/x/chat/a.jsonl", text: `## Goals\n(none)\n- rotate ${GH_TOKEN}\n## Decisions (and why)\n- x`, at: new Date("2026-09-29T23:59:00Z") });
    const daily = readFileSync(join(home, "history", "2026-09-29.md"), "utf8");
    expect(daily).not.toContain(GH_TOKEN);
    expect(daily).toContain("### 23:59 · new · rotate [REDACTED] · `a.jsonl`");
    expect(daily).toContain("#### Decisions (and why)");
    expect(summaryTopic("no headings here\nmore")).toBe("no headings here");
  });

  test("dates and file names follow the workspace time zone", () => {
    const writer = new HistoryWriter({ home, agentDir, tz: "Asia/Tokyo" });
    writer.writeSession({ reason: "compaction", sessionFile: "/x/chat/a.jsonl", text: "## Goals\n- late", at: new Date("2026-09-29T20:00:00Z") });
    expect(readFileSync(join(home, "history", "2026-09-30.md"), "utf8")).toContain("### 05:00 · compaction · late");
  });
});

describe("links planted in ~/history", () => {
  const MARKER = "SECRET_MARKER_rt_live";
  let target: string;
  beforeEach(() => {
    target = join(root, "target.json");
    writeFileSync(target, MARKER);
  });

  function runOnce(runs: ReturnType<typeof setup>["runs"]): string {
    const runId = runs.startRun({ agentName: "main", task: "hi", sessionFile: chatFile() });
    clock = new Date("2026-09-29T10:00:06Z");
    runs.endRun(runId, { status: "done" });
    return runId;
  }

  test("a symlinked or hardlinked daily file is replaced, never read or written through", () => {
    mainSession();
    mkdirSync(join(home, "history"));
    const daily = join(home, "history", "2026-09-29.md");
    symlinkSync(target, daily);
    runOnce(setup().runs);
    expect(readFileSync(target, "utf8")).toBe(MARKER);
    expect(lstatSync(daily).isSymbolicLink()).toBe(false);
    expect(readFileSync(daily, "utf8")).not.toContain(MARKER);

    rmSync(daily);
    linkSync(target, daily);
    runOnce(setup().runs);
    expect(readFileSync(target, "utf8")).toBe(MARKER);
    expect(readFileSync(daily, "utf8")).not.toContain(MARKER);
    expect(readdirSync(join(home, "history")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a run file symlinked ahead of time is replaced, not written through", () => {
    mainSession();
    mkdirSync(join(home, "history", "2026-09"), { recursive: true });
    const runId = "01KNOWNRUNID0000000000000A";
    symlinkSync(target, join(home, "history", "2026-09", `29-${runId}.md`));
    const writer = new HistoryWriter({ home, agentDir, tz: "UTC" });
    const runs = recordHistory(new RunLog(stateDir, { newId: () => runId }), writer, log, () => clock);
    runOnce(runs);
    expect(readFileSync(target, "utf8")).toBe(MARKER);
    expect(readFileSync(join(home, "history", "2026-09", `29-${runId}.md`), "utf8")).toContain("deploy the thing please");
  });

  test("a symlinked history dir is refused and logged", () => {
    mainSession();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, "history"));
    runOnce(setup().runs);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(warnings.map((w) => w.msg)).toEqual(["failed to write the run's history file"]);
    const { writer } = setup();
    expect(() => writer.writeSession({ reason: "new", sessionFile: "/x/a.jsonl", text: "## Goals\n- x", at: clock })).toThrow("not a plain directory");
  });
});

describe("home git", () => {
  test("history/ stays out of the home repo", async () => {
    await scaffoldHome(home);
    mkdirSync(join(home, "history", "2026-09"), { recursive: true });
    for (const f of ["history/2026-09/29-X.md", "history/2026-09-29.md"]) writeFileSync(join(home, f), "x\n");
    const git = runnerGit(home);
    const ignored = (await git.raw(["check-ignore", "history/2026-09/29-X.md", "history/2026-09-29.md", "history"])).trim().split("\n");
    expect(ignored).toEqual(["history/2026-09/29-X.md", "history/2026-09-29.md", "history"]);
    expect((await git.raw(["status", "--porcelain", "--untracked-files=all"])).trim()).toBe("");
  });
});
