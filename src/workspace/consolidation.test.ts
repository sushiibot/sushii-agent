import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerGit } from "../orchestration/runner/runnerGit.ts";
import { MARKERS, SYSTEM_PROMPT, buildPrompt, parseProposal, pendingNotes, runConsolidation, type ConsolidationDeps } from "./consolidation.ts";
import { MEMORY_MD_CAP, commitHome, scaffoldHome } from "./home.ts";
import { containsSecret } from "./secretPatterns.ts";

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const k of Object.keys(GIT_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const USER_HEAD = "# USER.md: facts about drk\n\nCurated by the agent.\n\n";
const MEMORY_HEAD = "# MEMORY.md: durable memory\n\nCurated by the agent. Tags look like `(src: YYYY-MM-DD, <surface>:<messageId>)`.\n\n";

const USER = `${USER_HEAD}- Prefers metric units. (src: 2026-09-01, discord:111)\n- Lives in Berlin. (src: migrated)\n`;
const MEMORY =
  MEMORY_HEAD +
  [
    "- sushii-agent deploys on push to main. (src: 2026-09-02, discord:222)",
    "- sushii-agent auto-deploys from main via CI. (src: 2026-09-10, discord:333)",
    "- Grafana lives on the infra host. (src: 2026-09-03)",
    "- Old: the runner uses worktrees with a TTL. (src: 2026-08-01, discord:444)",
    "- Prefers rg over grep. (src: 2026-09-05, discord:555)",
  ]
    .map((l) => `${l}\n`)
    .join("");

const NOTE = `## notes\n- Started using uv everywhere (src: 2026-09-28, discord:666)\n${"- filler line about the day's work\n".repeat(80)}`;

let root: string;
let home: string;
let stateDir: string;
let prompts: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ws-consolidate-"));
  home = join(root, "home");
  stateDir = join(root, "state");
  await scaffoldHome(home);
  writeFileSync(join(home, "USER.md"), USER);
  writeFileSync(join(home, "MEMORY.md"), MEMORY);
  writeFileSync(join(home, "memory", "2026-09-28.md"), NOTE);
  await commitHome("seed", { home });
  prompts = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function reply(user: string, memory: string, summary = "merged: two deploy entries\ndropped: runner TTL (stale)"): string {
  return [MARKERS.userBegin, user, MARKERS.userEnd, MARKERS.memoryBegin, memory, MARKERS.memoryEnd, MARKERS.summaryBegin, summary, MARKERS.summaryEnd].join("\n");
}

const GOOD_MEMORY =
  MEMORY_HEAD +
  "- sushii-agent auto-deploys on every push to main via CI. (src: 2026-09-10, discord:333)\n" +
  "- Grafana lives on the infra host. (src: 2026-09-03)\n" +
  "- Prefers rg over grep. (src: 2026-09-05, discord:555)\n" +
  "- Uses uv for Python everywhere. (src: 2026-09-28, discord:666)\n";

function deps(text: string | ((prompt: string) => string)): ConsolidationDeps {
  return {
    home,
    stateDir,
    now: () => new Date("2026-09-29T04:00:00Z"),
    propose: async (system, prompt) => {
      expect(system).toBe(SYSTEM_PROMPT);
      prompts.push(prompt);
      return { text: typeof text === "string" ? text : text(prompt), model: "test/model" };
    },
    commit: (message, paths) => commitHome(message, { home, paths }),
  };
}

async function log(): Promise<string[]> {
  return (await runnerGit(home).raw(["log", "--format=%s"])).trim().split("\n");
}

async function headFiles(): Promise<string[]> {
  return (await runnerGit(home).raw(["show", "--name-only", "--format=", "HEAD"])).trim().split("\n");
}

const read = (name: string) => readFileSync(join(home, name), "utf8");

describe("gate", () => {
  test("skips when the daily notes grew too little, without calling the model", async () => {
    writeFileSync(join(home, "memory", "2026-09-28.md"), "- small note\n");
    const result = await runConsolidation(deps(reply(USER, GOOD_MEMORY)));
    expect(result.status).toBe("skipped");
    expect(prompts).toEqual([]);
    expect(read("MEMORY.md")).toBe(MEMORY);
  });

  test("runs on enough new bytes, on notes across enough days, or on a nearly full MEMORY.md", async () => {
    expect((await runConsolidation(deps(reply(USER, GOOD_MEMORY)))).status).toBe("applied");

    // Everything consumed: nothing new, so the next night skips.
    expect((await runConsolidation(deps(reply(USER, GOOD_MEMORY)))).status).toBe("skipped");

    for (const d of ["2026-09-29", "2026-09-30", "2026-10-01"]) writeFileSync(join(home, "memory", `${d}.md`), `- small ${d}\n`);
    const days = await runConsolidation(deps(reply(USER, GOOD_MEMORY)));
    expect(days.status).toBe("applied");
  });

  test("runs when MEMORY.md is over 90% of its cap", async () => {
    writeFileSync(join(home, "memory", "2026-09-28.md"), "- uv everywhere (src: 2026-09-28, discord:666)\n");
    const big = MEMORY + `- ${"x".repeat(Math.ceil(MEMORY_MD_CAP * 0.9))} (src: 2026-09-05, discord:555)\n`;
    writeFileSync(join(home, "MEMORY.md"), big);
    const result = await runConsolidation(deps(reply(USER, GOOD_MEMORY)));
    expect(result.status).toBe("applied");
  });

  test("force (the manual trigger) bypasses the gate", async () => {
    writeFileSync(join(home, "memory", "2026-09-28.md"), "- uv everywhere (src: 2026-09-28, discord:666)\n");
    const result = await runConsolidation(deps(reply(USER, GOOD_MEMORY)), { force: true });
    expect(result.status).toBe("applied");
  });
});

describe("apply", () => {
  test("a valid proposal is written, committed and logged to DREAMS.md", async () => {
    const result = await runConsolidation(deps(reply(USER, GOOD_MEMORY)));
    expect(result.status).toBe("applied");
    expect(read("MEMORY.md")).toBe(GOOD_MEMORY);
    expect(read("USER.md")).toBe(USER);

    const subjects = await log();
    expect(subjects.slice(0, 2)).toEqual(["memory: consolidation 2026-09-29 review log", "memory: consolidation 2026-09-29"]);
    const applySha = (await runnerGit(home).raw(["rev-parse", "HEAD~1"])).trim();
    expect(result.sha).toBe(applySha);
    expect((await runnerGit(home).raw(["show", "--name-only", "--format=", "HEAD~1"])).trim()).toBe("MEMORY.md");
    expect(await headFiles()).toEqual(["DREAMS.md"]);

    const dreams = read("DREAMS.md");
    expect(dreams).toContain("## 2026-09-29 consolidation: applied");
    expect(dreams).toContain(`- Commit: ${applySha.slice(0, 12)}`);
    expect(dreams).toContain("- MEMORY.md: 5 → 4 entries");
    expect(dreams).toContain("- USER.md: 2 → 2 entries");
    expect(dreams).toContain("merged: two deploy entries");
    expect(dreams).toContain("- Notes read: memory/2026-09-28.md");
    expect((await runnerGit(home).raw(["status", "--porcelain"])).trim()).toBe("");
  });

  test("a failed commit is recorded as failed, not as a no-op", async () => {
    const d = deps(reply(USER, GOOD_MEMORY));
    d.commit = async (message, paths) => {
      if (paths.includes("MEMORY.md")) throw new Error("index.lock exists");
      return commitHome(message, { home, paths });
    };
    const result = await runConsolidation(d);
    expect(result.status).toBe("applied");
    expect(read("MEMORY.md")).toBe(GOOD_MEMORY);
    expect(read("DREAMS.md")).toContain("- Commit: failed (index.lock exists)");
  });

  test("the prompt carries both files, the notes with their dates, and the rules", async () => {
    await runConsolidation(deps(reply(USER, GOOD_MEMORY)));
    const prompt = prompts[0]!;
    expect(prompt).toContain(USER.trimEnd());
    expect(prompt).toContain(MEMORY.trimEnd());
    expect(prompt).toContain('<daily-note file="memory/2026-09-28.md" date="2026-09-28">');
    expect(prompt).toContain("Never add a fact that isn't present in the inputs.");
    expect(prompt).toContain("Keep every surviving entry's source tag exactly as written.");
    expect(prompt).toContain("Don't move entries between USER.md and MEMORY.md unless one is clearly misfiled.");
  });

  test("the daily-note input is bounded; the rest waits for the next run", () => {
    writeFileSync(join(home, "memory", "2026-09-29.md"), "- second day\n".repeat(50));
    const first = pendingNotes(home, {}, 1000);
    expect(first.chunks).toHaveLength(1);
    expect(Buffer.byteLength(first.chunks[0]!.text)).toBeLessThanOrEqual(1000);
    expect(first.chunks[0]!.text.endsWith("\n")).toBe(true);
    expect(first.newDays).toBe(2);
    const second = pendingNotes(home, { "2026-09-28.md": first.chunks[0]!.endOffset }, 100_000);
    expect(second.chunks.map((c) => c.file)).toEqual(["2026-09-28.md", "2026-09-29.md"]);
    expect(first.chunks[0]!.text + second.chunks[0]!.text).toBe(NOTE);
  });
});

describe("validation failures leave memory untouched and log the proposal", () => {
  async function expectRejected(text: string | ((p: string) => string), reason: RegExp, memoryAfter = read("MEMORY.md")) {
    const userBefore = read("USER.md");
    const result = await runConsolidation(deps(text));
    expect(result.status).toBe("rejected");
    expect(result.reasons!.join("\n")).toMatch(reason);
    expect(read("USER.md")).toBe(userBefore);
    expect(read("MEMORY.md")).toBe(memoryAfter);
    const dreams = read("DREAMS.md");
    expect(dreams).toContain("## 2026-09-29 consolidation: rejected (memory files untouched)");
    expect(dreams).toContain("Proposal (redacted):");
    expect(dreams).toMatch(reason);
    expect((await log())[0]).toBe("memory: consolidation 2026-09-29 rejected");
    expect(await headFiles()).toEqual(["DREAMS.md"]);
    // Not consumed: the same notes are offered again next time.
    expect(existsSync(join(stateDir, "consolidation.json"))).toBe(false);
    return dreams;
  }

  test("hash check: a file changed while the model ran", async () => {
    const midRun = `${MEMORY}- Added mid-run. (src: 2026-09-29)\n`;
    await expectRejected(
      () => {
        writeFileSync(join(home, "MEMORY.md"), midRun);
        return reply(USER, GOOD_MEMORY);
      },
      /MEMORY\.md changed after the job read it/,
      midRun,
    );
  });

  test("over cap", async () => {
    const huge = MEMORY_HEAD + Array.from({ length: 200 }, (_, i) => `- Entry ${i} ${"y".repeat(40)} (src: 2026-09-03)\n`).join("");
    await expectRejected(reply(USER, huge), /MEMORY\.md is \d+ chars, over its 8000-char cap/);
  });

  test("a bullet without a source tag", async () => {
    await expectRejected(reply(USER, `${GOOD_MEMORY}- Likes tea.\n`), /MEMORY\.md: 1 bullet\(s\) without a valid source tag/);
  });

  test("the template placeholder isn't a valid tag", async () => {
    await expectRejected(reply(USER, `${GOOD_MEMORY}- Likes tea. (src: YYYY-MM-DD, <surface>:<messageId>)\n`), /without a valid source tag/);
  });

  test("a source tag that isn't in the inputs (an invented fact)", async () => {
    await expectRejected(reply(USER, `${GOOD_MEMORY}- Owns a boat. (src: 2026-09-20, discord:999)\n`), /source tag\(s\) not present in the inputs: \(src: 2026-09-20, discord:999\)/);
  });

  test("a secret in the proposal is rejected and redacted from DREAMS.md", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const dreams = await expectRejected(reply(USER, `${GOOD_MEMORY}- GitHub token ${token} (src: 2026-09-05, discord:555)\n`), /MEMORY\.md contains something secret-shaped/);
    expect(dreams).not.toContain(token);
    expect(containsSecret(dreams)).toBe(false);
  });

  test("catastrophic shrink", async () => {
    await expectRejected(reply(USER, `${MEMORY_HEAD}- Prefers rg over grep. (src: 2026-09-05, discord:555)\n`), /MEMORY\.md would shrink from 5 to 1 entries/);
  });

  test("a malformed reply", async () => {
    await expectRejected(`Sure! Here is MEMORY.md:\n${GOOD_MEMORY}`, /expected exactly one =====BEGIN USER\.md=====/);
    const doubled = reply(USER, `${GOOD_MEMORY}${MARKERS.memoryEnd}\n`);
    expect(parseProposal(doubled).errors.join()).toMatch(/exactly one =====BEGIN MEMORY\.md=====/);
  });
});

test("buildPrompt says when there are no new notes", () => {
  expect(buildPrompt({ user: USER, memory: MEMORY, notes: [], today: "2026-09-29" })).toContain("(no new daily notes)");
});
