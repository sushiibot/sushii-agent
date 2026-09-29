import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { RunLog } from "./runLog.ts";
import { createSecretGuardExtension } from "./secretGuard.ts";
import { subagentSessionDir } from "./sessionPaths.ts";
import { writeWorkspaceState } from "./state.ts";
import { redact, runWsRuns } from "./wsRuns.ts";

// Prod layout: /data/home, /data/pi-agent, /data/.workspace.
let root: string;
let home: string;
let agentDir: string;
let stateDir: string;
let chatFile: string;
let mainRun: string;
let earlierRun: string;
let childRun: string;
let hostileRun: string;
let symlinkRun: string;
let hardlinkRun: string;
let outsideRun: string;
let agent2: string;

// A Pi-session-shaped file outside the session roots, e.g. the operator's docker-exec `pi` sessions.
const MARKER = "OPERATOR_SESSION_MARKER";

const GH_TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
const SK_KEY = "sk-or-v1-0123456789abcdefABCDEF";
const HEX_KEY = "0123456789abcdef".repeat(4);
const LONG_PATH = "/data/home/projects/MyRepo2/src/components/ButtonGroupWrapper";

function sessionLines(entries: object[]): string {
  return `${[{ type: "session", version: 3, id: "s1", timestamp: "2026-09-29T09:00:00.000Z", cwd: "/data/home" }, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`;
}

const msg = (id: string, ts: string, message: object) => ({ type: "message", id, parentId: null, timestamp: ts, message });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ws-runs-"));
  home = join(root, "home");
  agentDir = join(root, "pi-agent");
  stateDir = join(root, ".workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(agentDir, "chat"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), '{"openai":{"refresh":"rt_supersecret"}}');

  chatFile = join(agentDir, "chat", "2026-09-29_s1.jsonl");
  writeFileSync(
    chatFile,
    sessionLines([
      msg("e1", "2026-09-29T09:00:05.000Z", { role: "user", content: [{ type: "text", text: "earlier question about zebras" }] }),
      msg("e2", "2026-09-29T09:00:09.000Z", { role: "assistant", content: [{ type: "text", text: "zebras are striped" }], stopReason: "stop" }),
      msg("e3", "2026-09-29T10:00:01.000Z", { role: "user", content: "deploy the thing" }),
      msg("e4", "2026-09-29T10:00:02.000Z", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private thoughts" },
          { type: "text", text: "Running it." },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: `curl -H 'Authorization: Bearer abc.def-ghi' ${LONG_PATH}` } },
        ],
        stopReason: "toolUse",
      }),
      msg("e5", "2026-09-29T10:00:03.000Z", {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: `token=${GH_TOKEN} key=${SK_KEY} ${"x".repeat(400)} TAILMARK` }],
        isError: false,
      }),
      msg("e5b", "2026-09-29T10:00:03.500Z", {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "read",
        content: [{ type: "text", text: `${"z".repeat(280)} ${HEX_KEY}` }],
        isError: false,
      }),
      msg("e6", "2026-09-29T10:00:04.000Z", { role: "assistant", content: [{ type: "text", text: "Deployed the Kangaroo build." }], stopReason: "stop" }),
    ]),
  );

  writeFileSync(
    join(agentDir, "chat", "2026-09-28_self.jsonl"),
    sessionLines([
      msg("w0", "2026-09-28T08:00:00.000Z", { role: "user", content: "find alpaca notes" }),
      msg("w1", "2026-09-28T08:00:01.000Z", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "ws1", name: "bash", arguments: { command: "ws-runs search alpaca --limit 5" } },
          { type: "toolCall", id: "ws2", name: "bash", arguments: { command: "echo alpaca-echo" } },
        ],
        stopReason: "toolUse",
      }),
      msg("w2", "2026-09-28T08:00:02.000Z", { role: "toolResult", toolCallId: "ws1", toolName: "bash", content: [{ type: "text", text: "RESULTMARK alpaca hit" }] }),
      msg("w3", "2026-09-28T08:00:03.000Z", { role: "toolResult", toolCallId: "ws2", toolName: "bash", content: [{ type: "text", text: "alpaca-echo" }] }),
    ]),
  );

  const childDir = subagentSessionDir(agentDir, "PARENT");
  mkdirSync(childDir, { recursive: true });
  const childFile = join(childDir, "child.jsonl");
  writeFileSync(
    childFile,
    sessionLines([
      msg("c1", "2026-09-29T10:00:02.500Z", { role: "user", content: "research kangaroos" }),
      msg("c2", "2026-09-29T10:00:02.800Z", { role: "assistant", content: [{ type: "text", text: "Kangaroos hop." }], stopReason: "stop" }),
    ]),
  );

  // Agent-writable inputs pointing at files ws-runs must never print.
  symlinkSync(join(agentDir, "auth.json"), join(agentDir, "chat", "sneaky.jsonl"));
  linkSync(join(agentDir, "auth.json"), join(agentDir, "chat", "hard.jsonl"));

  // Separate session-shaped files per attack, so each test fails only if its own check is removed.
  const opDir = join(agentDir, "sessions", "--data-home--");
  mkdirSync(opDir, { recursive: true });
  const opSession = (name: string) => {
    const f = join(opDir, name);
    writeFileSync(f, sessionLines([msg("o1", "2026-09-29T10:00:01.000Z", { role: "user", content: `${MARKER} ${name}` })]));
    return f;
  };
  symlinkSync(opSession("sym.jsonl"), join(agentDir, "chat", "linked.jsonl"));
  linkSync(opSession("hard.jsonl"), join(agentDir, "chat", "hardlinked.jsonl"));
  const direct = opSession("direct.jsonl");
  // A second agent dir whose session root is a symlink to the operator's sessions.
  agent2 = join(root, "agent2");
  mkdirSync(agent2, { recursive: true });
  symlinkSync(join(agentDir, "sessions"), join(agent2, "chat"));
  opSession("viaroot.jsonl");

  writeWorkspaceState(stateDir, { chatSessionFile: chatFile });
  let now = new Date("2026-09-29T09:00:04.000Z");
  const log = new RunLog(stateDir, { now: () => now });
  earlierRun = log.startRun({ agentName: "main", task: "earlier question about zebras", sessionFile: chatFile });
  now = new Date("2026-09-29T09:00:10.000Z");
  log.endRun(earlierRun, { status: "done", usage: { inputTokens: 5, outputTokens: 3 } });
  now = new Date("2026-09-29T10:00:00.000Z");
  mainRun = log.startRun({ agentName: "main", task: "deploy the thing", sessionFile: chatFile });
  now = new Date("2026-09-29T10:00:02.400Z");
  childRun = log.startRun({ agentName: "researcher", parentRunId: mainRun, task: "research kangaroos", sessionFile: childFile });
  now = new Date("2026-09-29T10:00:02.900Z");
  log.endRun(childRun, { status: "done", resultSummary: "Kangaroos hop." });
  now = new Date("2026-09-29T10:00:05.000Z");
  log.endRun(mainRun, { status: "done", usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.0123 }, resultSummary: "Deployed" });
  hostileRun = log.startRun({ agentName: "main", task: "hostile", sessionFile: join(agentDir, "chat", "sneaky.jsonl") });
  symlinkRun = log.startRun({ agentName: "main", task: "hostile", sessionFile: join(agentDir, "chat", "linked.jsonl") });
  hardlinkRun = log.startRun({ agentName: "main", task: "hostile", sessionFile: join(agentDir, "chat", "hardlinked.jsonl") });
  outsideRun = log.startRun({ agentName: "main", task: "hostile", sessionFile: direct });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Runs the CLI with only HOME in env, as the agent's bash has it (PI_* and WORKSPACE_* are dropped). */
function cli(...args: string[]): { code: number; out: string; err: string } {
  return cliWith({ env: { HOME: home } }, ...args);
}

function cliWith(opts: { env: NodeJS.ProcessEnv; agentDirs?: string[] }, ...args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runWsRuns(args, { env: opts.env, agentDirs: opts.agentDirs ?? [agentDir], out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("redact", () => {
  test("masks tokens and blobs but keeps paths and prose", () => {
    const hex = "a".repeat(20) + "0123456789abcdef01234";
    const b64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ9xY2VhYmMxMjM0NTY3ODkw";
    const text = `Bearer abc.def ${GH_TOKEN} ${SK_KEY} ${hex} ${b64} ${LONG_PATH} ULID 01J9ZQ8G6KX3T1V2W3Y4Z5A6B7`;
    const out = redact(text);
    for (const secret of ["abc.def", GH_TOKEN, SK_KEY, hex, b64]) expect(out).not.toContain(secret);
    expect(out).toContain(LONG_PATH);
    expect(out).toContain("01J9ZQ8G6KX3T1V2W3Y4Z5A6B7");
  });

  test("masks hex glued to a word, lowercase tokens, blobs after a slash and JWTs", () => {
    const lower = "a8d7f6g5h4j3k2l1m0n9b8v7c6x5z4q3";
    const blob = "AbCdEfGh1234567890IjKlMnOpQrStUvWxYz";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const discord = `${"M".repeat(4)}TIzNDU2Nzg5MDEyMzQ1Njc4.GhIjKl.${"a1".repeat(15)}`;
    const cases = [`secret_${HEX_KEY}`, `0x${HEX_KEY}`, lower, `/data/home/x/${blob}`, `/${blob}`, jwt, discord];
    for (const c of cases) {
      const out = redact(`value ${c} end`);
      expect(out).toContain("[REDACTED]");
      for (const secret of [HEX_KEY, lower, blob, "c2lnbmF0dXJl", "eyJzdWIiOiIxIn0", "a1".repeat(15)]) expect(out).not.toContain(secret);
    }
    expect(redact(`id_${"deadbeef".repeat(5)}`)).toBe("id_[REDACTED]");
    expect(redact("/data/home/x/")).toBe("/data/home/x/");
    // Kebab identifiers and UUIDs are long but made of short words.
    for (const keep of ["session-history-skill-template-directory", "0b1c9f3e-2a4d-4e8b-9c1a-7f6e5d4c3b2a"]) expect(redact(keep)).toBe(keep);
  });
});

describe("ws-runs list", () => {
  test("prints a table of runs, newest first, with filters", () => {
    const all = cli("list");
    expect(all.code).toBe(0);
    const rows = all.out.split("\n");
    expect(rows[0]).toMatch(/^RUN\s+STARTED/);
    expect(rows[1]).toContain(outsideRun);
    expect(all.out.indexOf(mainRun)).toBeLessThan(all.out.indexOf(earlierRun));
    expect(all.out).toContain("1200/80 $0.0123");

    const children = cli("list", "--parent", mainRun);
    expect(children.out).toContain(childRun);
    expect(children.out).not.toContain(earlierRun);
    expect(cli("list", "--agent", "researcher").out.split("\n")).toHaveLength(2);
    expect(cli("list", "--limit", "1").out.split("\n")).toHaveLength(2);
    expect(cli("list", "--since", "2026-09-29T09:30:00Z").out).not.toContain(earlierRun);
    expect(cli("list", "--since", "yesterday-ish").code).toBe(1);

    const current = cliWith({ env: { HOME: home, WS_RUN_ID: mainRun } }, "list", "--parent");
    expect(current.out).toContain(`current run: ${mainRun}`);
    expect(current.out).toContain(childRun);
    expect(current.out).not.toContain(earlierRun);
    expect(cli("list", "--parent").code).toBe(1);
  });
});

describe("ws-runs show", () => {
  test("prints metadata and only that run's transcript, redacted", () => {
    const { code, out } = cli("show", mainRun);
    expect(code).toBe(0);
    expect(out).toContain(`run:      ${mainRun}`);
    expect(out).toContain("session:  chat/2026-09-29_s1.jsonl");
    expect(out).toContain("user: deploy the thing");
    expect(out).toContain("assistant: Running it.");
    expect(out).toContain("→ bash {\"command\":\"curl -H 'Authorization: Bearer [REDACTED]'");
    expect(out).toContain("← bash:");
    expect(out).toMatch(/… \[\d+ more chars\]/);
    expect(out).not.toContain("TAILMARK");
    expect(out).toContain("assistant: Deployed the Kangaroo build.");
    expect(out).not.toContain("zebras are striped");
    expect(out).not.toContain("private thoughts");
    expect(out).not.toContain(GH_TOKEN);
    expect(out).not.toContain(SK_KEY);
    expect(out).toContain(LONG_PATH);
    expect(out).not.toContain(root);
  });

  test("redacts before clipping, so no fragment of a cut secret survives", () => {
    const { out } = cli("show", mainRun);
    expect(out).toContain("← read:");
    expect(out).not.toMatch(/[0-9a-f]{12,}/);
  });

  test("--full prints complete tool results", () => {
    const { out } = cli("show", mainRun, "--full");
    expect(out).toContain("TAILMARK");
    expect(out).not.toContain(GH_TOKEN);
  });

  test("shows a subagent's own session", () => {
    const { out } = cli("show", childRun);
    expect(out).toContain(`(parent ${mainRun})`);
    expect(out).toContain("session:  subagents/PARENT/child.jsonl");
    expect(out).toContain("assistant: Kangaroos hop.");
  });

  test("never prints a file that isn't a Pi session under the session dirs", () => {
    const { code, out } = cli("show", hostileRun);
    expect(code).toBe(0);
    expect(out).not.toContain("rt_supersecret");
    expect(out).toContain("not shown");
    expect(cli("show", "NOPE").code).toBe(1);
  });

  test("defaults to the current run from WS_RUN_ID", () => {
    const { code, out } = cliWith({ env: { HOME: home, WS_RUN_ID: childRun } }, "show");
    expect(code).toBe(0);
    expect(out).toContain(`run:      ${childRun}`);
    expect(cli("show").code).toBe(1);
  });
});

// Each fixture is a valid Pi session outside the session roots, so only the check under test stops it.
describe("ws-runs session confinement", () => {
  test("a session symlinked into chat/ is not shown", () => {
    const { out } = cli("show", symlinkRun);
    expect(out).toContain("not shown");
    expect(out).not.toContain(MARKER);
  });

  test("a session hard-linked into chat/ is neither shown nor searched", () => {
    const { out } = cli("show", hardlinkRun);
    expect(out).toContain("not shown");
    expect(out).not.toContain(MARKER);
    expect(cli("search", "hard.jsonl").out).not.toContain(MARKER);
  });

  test("a run pointing straight at a session outside the roots is not shown", () => {
    const { out } = cli("show", outsideRun);
    expect(out).toContain("not shown");
    expect(out).not.toContain(MARKER);
  });

  test("a session root that is a symlink is skipped", () => {
    const { out } = cliWith({ env: { HOME: home }, agentDirs: [agentDir, agent2] }, "search", "viaroot");
    expect(out).toBe("no matches");
  });

  test("env and state.json don't move the session roots", async () => {
    // A self-contained tree with only a real, non-pinned agent dir holding the marker.
    const t = mkdtempSync(join(tmpdir(), "ws-runs-pin-"));
    try {
      const tHome = join(t, "home");
      const tState = join(t, ".workspace");
      const other = join(t, "other-agent");
      mkdirSync(tHome, { recursive: true });
      mkdirSync(join(other, "chat"), { recursive: true });
      const file = join(other, "chat", "s.jsonl");
      writeFileSync(file, sessionLines([msg("o1", "2026-09-29T10:00:01.000Z", { role: "user", content: `${MARKER} pinned` })]));
      writeWorkspaceState(tState, { chatSessionFile: file });
      const runId = new RunLog(tState).startRun({ agentName: "main", task: "t", sessionFile: file });
      const env = { HOME: tHome, PI_CODING_AGENT_DIR: other, PI_AGENT_DIR: other, PATH: process.env.PATH ?? "" };
      const bin = resolve(import.meta.dir, "../../bin/ws-runs.ts");
      for (const args of [["show", runId], ["search", MARKER]]) {
        const proc = Bun.spawn(["bun", bin, ...args], { env, stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        expect(out).not.toContain(MARKER);
      }
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("ws-runs search", () => {
  test("finds text across session files case-insensitively and names the run", () => {
    const { code, out } = cli("search", "KANGAROO");
    expect(code).toBe(0);
    const lines = out.split("\n");
    expect(lines.some((l) => l.startsWith(`${mainRun}  chat/2026-09-29_s1.jsonl  2026-09-29 10:00:04`) && l.includes("Kangaroo build"))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${childRun}  subagents/PARENT/child.jsonl`))).toBe(true);
    expect(cli("search", "zebras").out).toContain(earlierRun);
    expect(cli("search", "kangaroo", "--limit", "1").out.split("\n")).toHaveLength(1);
  });

  test("leaves out ws-runs invocations and their output", () => {
    const { out } = cli("search", "alpaca");
    expect(out).toContain("find alpaca notes");
    expect(out).toContain("echo alpaca-echo");
    expect(out).not.toContain("ws-runs search");
    expect(out).not.toContain("RESULTMARK");
  });

  test("redacts hits and skips non-session files", () => {
    const hit = cli("search", "token=");
    expect(hit.out).toContain("[REDACTED]");
    expect(hit.out).not.toContain(GH_TOKEN);
    expect(cli("search", "rt_supersecret").out).toBe("no matches");
    // Otherwise a secret could be guessed one character at a time from hit/no-hit.
    expect(cli("search", HEX_KEY.slice(0, 6)).out).toBe("no matches");
    expect(cli("search", GH_TOKEN.slice(0, 8)).out).toBe("no matches");
    expect(cli("search", "openai").out).toBe("no matches");
  });
});

describe("ws-runs and the secret guard", () => {
  test("the guard lets the agent's bash run ws-runs", () => {
    let handler: ((e: { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }) => ToolCallEventResult | undefined) | undefined;
    const pi = { on: (event: string, fn: typeof handler) => event === "tool_call" && (handler = fn) } as unknown as ExtensionAPI;
    createSecretGuardExtension({ agentDir: "/data/pi-agent", cwd: "/data/home", home: "/data/home", log: { warn: () => {} } })(pi);
    for (const command of [`ws-runs show ${mainRun}`, `ws-runs show ${mainRun} --full`, "ws-runs list --limit 20 --agent main", 'ws-runs search "deploy failed" --limit 5']) {
      expect(handler!({ type: "tool_call", toolCallId: "t", toolName: "bash", input: { command } })).toBeUndefined();
    }
    expect(handler!({ type: "tool_call", toolCallId: "t", toolName: "bash", input: { command: "cat /data/pi-agent/chat/x.jsonl" } })?.block).toBe(true);
  });

  test("the bin entry works with only HOME set", async () => {
    const bin = resolve(import.meta.dir, "../../bin/ws-runs.ts");
    const proc = Bun.spawn(["bun", bin, "show", mainRun], { env: { HOME: home, PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    // The fixture's agent dir isn't the pinned /data/pi-agent, so only the run's metadata prints.
    expect(out).toContain(`run:      ${mainRun}`);
    expect(out).toContain("not shown");
  });
});
