import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerGit, runnerGitEnv } from "./runnerGit.ts";

const ENV_KEYS = ["ORCH_SECRET", "ORCH_RUNNER_SECRET", "PAGER", "GIT_SSH_COMMAND"] as const;

describe("runner git never carries ORCH_* env", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-git-"));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ORCH_SECRET = "ws-leak-me";
    process.env.ORCH_RUNNER_SECRET = "runner-leak-me";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("runnerGitEnv drops ORCH_* and keeps the rest", () => {
    const env = runnerGitEnv({ PATH: "/usr/bin", ORCH_SECRET: "a", ORCH_RUNNER_SECRET: "b", ORCH_URL: "ws://x" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("a repo-planted core.fsmonitor run by the runner's git sees no ORCH_* vars", async () => {
    await runnerGit(dir).init();
    const dump = join(dir, "env-dump.txt");
    const script = join(dir, "fsm.sh");
    writeFileSync(script, `#!/bin/sh\nenv > "${dump}"\nexit 1\n`);
    chmodSync(script, 0o755);
    // Planted the way an agent would, with plain git; simple-git's own API refuses this config.
    Bun.spawnSync(["git", "-C", dir, "config", "core.fsmonitor", script]);
    writeFileSync(join(dir, "f.txt"), "x");

    await runnerGit(dir).status();

    const dumped = readFileSync(dump, "utf8");
    expect(dumped).toContain("PATH=");
    expect(dumped).not.toContain("ORCH_");
    expect(dumped).not.toContain("leak-me");
  });

  test("still runs when the runner env holds vars simple-git treats as unsafe", async () => {
    process.env.PAGER = "less";
    process.env.GIT_SSH_COMMAND = "ssh";
    await runnerGit(dir).init();
    expect((await runnerGit(dir).status()).isClean()).toBe(true);
  });
});

describe("runner sources route every subprocess through a stripped env", () => {
  const root = import.meta.dir;
  const sources = (function walk(d: string): string[] {
    return readdirSync(d).flatMap((name) => {
      const p = join(d, name);
      if (statSync(p).isDirectory()) return walk(p);
      return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
  })(root);

  test("only runnerGit.ts constructs simple-git", () => {
    const offenders = sources.filter((p) => {
      if (p.endsWith("runnerGit.ts")) return false;
      return /import\s+simpleGit\b|import\s+\{[^}]*\bsimpleGit\b[^}]*\}\s+from\s+"simple-git"|require\("simple-git"\)/.test(readFileSync(p, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  test("every child_process / Bun.spawn call passes an ORCH-stripped env", () => {
    const offenders: string[] = [];
    for (const p of sources) {
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/(?<![.\w])(?:spawnSync|spawn|execFileSync|execFile|execSync)\(|Bun\.spawn(?:Sync)?\(/g)) {
        const call = src.slice(m.index, src.indexOf(";", m.index));
        if (!/env\b/.test(call)) offenders.push(`${p}: ${call.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
