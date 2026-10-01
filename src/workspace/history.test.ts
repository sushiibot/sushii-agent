import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerGit } from "../agentRuntime/runnerGit.ts";
import { HistoryWriter, recordHistory, renderTranscript, summaryTopic } from "./history.ts";
import { scaffoldHome } from "./home.ts";
import { flushPrompt } from "./memoryFlush.ts";
import { RunLog, tailLinesOfFd } from "./runLog.ts";
import { openConfinedSessionSync, realRoots } from "./wsRuns.ts";
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

describe("hostile or unusual input", () => {
  const runMain = (runs: ReturnType<typeof setup>["runs"], task = "hi") => {
    const runId = runs.startRun({ agentName: "main", task, sessionFile: chatFile() });
    clock = new Date("2026-09-29T10:00:06Z");
    runs.endRun(runId, { status: "done" });
    return runId;
  };

  test("a FIFO planted at the daily path doesn't block the host; it's replaced", () => {
    mainSession();
    mkdirSync(join(home, "history"));
    const daily = join(home, "history", "2026-09-29.md");
    expect(spawnSync("mkfifo", [daily]).status).toBe(0);
    const started = Date.now();
    runMain(setup().runs);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lstatSync(daily).isFile()).toBe(true);
    expect(readFileSync(daily, "utf8")).toContain("deploy the thing please");
  });

  test("a session swapped for a FIFO doesn't block the host; the run file says there's no session", () => {
    mainSession();
    const { runs } = setup();
    const runId = runs.startRun({ agentName: "main", task: "deploy", sessionFile: chatFile() });
    rmSync(chatFile());
    expect(spawnSync("mkfifo", [chatFile()]).status).toBe(0);
    const started = Date.now();
    runs.endRun(runId, { status: "done" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readFileSync(join(home, "history", "2026-09", `29-${runId}.md`), "utf8")).toContain("no session file for this run");
  });

  test("the checked fd is what gets read: swapping the path for a FIFO after the check changes nothing", () => {
    mainSession();
    const opened = openConfinedSessionSync(chatFile(), realRoots([agentDir]))!;
    expect(opened).not.toBeNull();
    try {
      rmSync(chatFile());
      expect(spawnSync("mkfifo", [chatFile()]).status).toBe(0);
      const lines = [...tailLinesOfFd(opened.fd, opened.size)];
      expect(lines.at(-1)).toContain('"type":"session"');
      expect(lines.join("\n")).toContain("deploy the thing please");
    } finally {
      closeSync(opened.fd);
    }
    expect(openConfinedSessionSync(chatFile(), realRoots([agentDir]))).toBeNull();
  });

  test("a read error other than a missing file leaves the daily index alone and is logged", () => {
    if (process.getuid?.() === 0) return;
    mainSession();
    mkdirSync(join(home, "history"));
    const daily = join(home, "history", "2026-09-29.md");
    writeFileSync(daily, "# 2026-09-29\n\n## Runs\n\n- 09:00 chat — earlier (0 tools, done)\n\n## Sessions\n");
    chmodSync(daily, 0o000);
    try {
      runMain(setup().runs);
    } finally {
      chmodSync(daily, 0o644);
    }
    expect(readFileSync(daily, "utf8")).toContain("- 09:00 chat — earlier");
    expect(warnings.map((w) => w.msg)).toEqual(["failed to write the run's history file"]);
  });

  test("huge tool args and messages are redacted in bounded time and truncated", () => {
    const jwt = `eyJ${"a".repeat(300)}.${"b".repeat(300)}.${"c".repeat(300)}`;
    writeSession(chatFile(), [
      msg("e1", "2026-09-29T10:00:01.000Z", { role: "user", content: `[discord:1 x]\n${"u".repeat(200_000)}` }),
      msg("e2", "2026-09-29T10:00:02.000Z", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "write", arguments: { path: "big.txt", content: "z".repeat(200_000) } },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: `${jwt} ${jwt} ${jwt} ${GH_TOKEN}` } },
        ],
        stopReason: "toolUse",
      }),
      msg("e3", "2026-09-29T10:00:03.000Z", { role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "q".repeat(200_000) }], isError: false }),
    ]);
    const started = Date.now();
    const runId = runMain(setup().runs);
    expect(Date.now() - started).toBeLessThan(1000);
    const md = readFileSync(join(home, "history", "2026-09", `29-${runId}.md`), "utf8");
    expect(md.length).toBeLessThan(20_000);
    expect(md).toContain("_[truncated; 200014 chars in all]_");
    const [write, bash] = md.split("\n").filter((l) => l.startsWith("- `"));
    expect(write!.length).toBeLessThan(250);
    expect(bash).toStartWith("- `bash` {\"command\":\"[REDACTED] [REDACTED] [REDACTED]");
    expect(md).not.toContain("ghp_");
    expect(md).not.toContain("A1b2C3d4");
  });

  test("an auth error keeps the status but drops the token endpoint's body", () => {
    writeSession(chatFile(), [
      msg("e1", "2026-09-29T10:00:01.000Z", { role: "user", content: "hi" }),
      msg("e2", "2026-09-29T10:00:02.000Z", {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: 'OpenAI OAuth token request failed (400) {"error":"invalid_grant","refresh_token":"rt_AbCdEfGhIjKlMnOp.QrStUvWx"}',
      }),
    ]);
    const runId = runMain(setup().runs);
    const md = readFileSync(join(home, "history", "2026-09", `29-${runId}.md`), "utf8");
    expect(md).toContain("_[error: OpenAI OAuth token request failed (400)]_");
    expect(md).not.toContain("invalid_grant");
    expect(md).not.toContain("rt_AbCd");
  });

  test("a memory flush turn is labelled as a flush, not a chat request", () => {
    const flush = flushPrompt("rotate");
    writeSession(chatFile(), [
      msg("e1", "2026-09-29T10:00:01.000Z", { role: "user", content: flush }),
      msg("e2", "2026-09-29T10:00:02.000Z", { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }], stopReason: "stop" }),
    ]);
    const runId = runMain(setup().runs, flush);
    expect(readFileSync(join(home, "history", "2026-09", `29-${runId}.md`), "utf8")).toStartWith(`# flush run ${runId}`);
    expect(readFileSync(join(home, "history", "2026-09-29.md"), "utf8")).toContain(`- 10:00 flush — memory flush (0 tools, done) [${runId}]`);
  });

  test("entries appended while the session sat idle belong to the next run; each run keeps to its own window", () => {
    const { runs } = setup();
    writeSession(chatFile(), [
      msg("e0", "2026-09-29T09:59:00.000Z", { role: "user", content: "from before the host started" }),
      { type: "custom_message", id: "x0", parentId: null, timestamp: "2026-09-29T10:00:00.500Z", customType: "workspace_recap", content: "seeded recap", display: true },
      msg("e1", "2026-09-29T10:00:01.000Z", { role: "user", content: "first request" }),
      msg("e2", "2026-09-29T10:00:02.000Z", { role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "stop" }),
    ]);
    clock = new Date("2026-09-29T10:00:01Z");
    const first = runs.startRun({ agentName: "main", task: "first request", sessionFile: chatFile() });
    clock = new Date("2026-09-29T10:00:03Z");
    runs.endRun(first, { status: "done" });

    writeSession(chatFile(), [
      msg("e0", "2026-09-29T09:59:00.000Z", { role: "user", content: "from before the host started" }),
      msg("e1", "2026-09-29T10:00:01.000Z", { role: "user", content: "first request" }),
      msg("e2", "2026-09-29T10:00:02.000Z", { role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "stop" }),
      { type: "custom_message", id: "x1", parentId: null, timestamp: "2026-09-29T10:05:00.000Z", customType: "workspace_context", content: "channel chatter", display: true },
      msg("e3", "2026-09-29T10:06:01.000Z", { role: "user", content: "second request" }),
      msg("e4", "2026-09-29T10:06:02.000Z", { role: "assistant", content: [{ type: "text", text: "second answer" }], stopReason: "stop" }),
    ]);
    clock = new Date("2026-09-29T10:06:01Z");
    const second = runs.startRun({ agentName: "main", task: "second request", sessionFile: chatFile() });
    clock = new Date("2026-09-29T10:06:03Z");
    runs.endRun(second, { status: "done" });

    const firstMd = readFileSync(join(home, "history", "2026-09", `29-${first}.md`), "utf8");
    expect(firstMd).toContain("seeded recap");
    expect(firstMd).toContain("first answer");
    expect(firstMd).not.toContain("from before the host started");
    expect(firstMd).not.toContain("second request");
    const secondMd = readFileSync(join(home, "history", "2026-09", `29-${second}.md`), "utf8");
    expect(secondMd).toContain("channel chatter");
    expect(secondMd).toContain("second answer");
    expect(secondMd).not.toContain("first request");
  });
});

describe("cutting long text", () => {
  test("a cut through a secret whose prefix matches no pattern doesn't show the prefix", () => {
    let seed = 11;
    const rnd = (n: number) => {
      const cs = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let s = "";
      do {
        s = Array.from({ length: n }, () => cs[Math.floor((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 * cs.length)]).join("");
      } while (!/\d/.test(s) || !/[a-z]/i.test(s));
      return s;
    };
    const fill = (n: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27) + 1).slice(0, n);
    const render = (content: string) =>
      renderTranscript([{ type: "custom_message", timestamp: "2026-09-29T10:00:30.000Z", customType: "x", content } as never], "UTC").lines.join("\n");
    let longest = 0;
    for (let k = 0; k <= 8; k++) for (let pad = 0; pad < 500; pad += 30) for (const j of [5, 12, 20]) {
      const head = Array.from({ length: 8 }, () => rnd(15)).join("-");
      const token = `${head}.${rnd(6)}.${rnd(30)}`;
      const prefix = Array.from({ length: k }, () => `ghp_${rnd(36)} `).join("") + fill(pad) + " ";
      const start = 500 - (head.length + 1 + 6 + 1 + j);
      if (start < prefix.length) continue;
      const out = render(prefix + fill(start - prefix.length) + token + " " + fill(20_000));
      for (let n = longest + 1; n <= head.length; n++) {
        let seen = false;
        for (let a = 0; a + n <= head.length && !seen; a++) seen = out.includes(head.slice(a, a + n));
        if (!seen) break;
        longest = n;
      }
    }
    expect(longest).toBeLessThan(8);
  });
});
