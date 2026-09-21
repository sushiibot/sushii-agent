import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import simpleGit from "simple-git";
import { agentGitEnv, configureForAgent } from "./repoOps.ts";

describe("agentGitEnv", () => {
  test("returns the git/gh auth env pointing at the checkout's askpass helper", () => {
    expect(agentGitEnv("/work/repo", "ghs_tok")).toEqual({
      GH_TOKEN: "ghs_tok",
      GITHUB_TOKEN: "ghs_tok",
      GIT_ASKPASS: "/work/repo/.git/sushii-askpass.sh",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

describe("configureForAgent", () => {
  let dir: string;
  let cwd: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "repoops-"));
    const origin = join(dir, "origin.git");
    cwd = join(dir, "work");
    await simpleGit().init(["--bare", origin, "--initial-branch=main"]);
    await simpleGit().clone(origin, cwd);
    const g = simpleGit(cwd);
    await g.addConfig("user.name", "seed");
    await g.addConfig("user.email", "seed@x");
    await g.raw(["commit", "--allow-empty", "-m", "seed"]);
    await g.push(["origin", "main"]);
    await g.raw(["remote", "set-head", "origin", "main"]); // so the hook can resolve the default
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes an executable askpass helper and pre-push hook, no secret embedded", () => {
    configureForAgent(cwd);
    const askpass = join(cwd, ".git/sushii-askpass.sh");
    const hook = join(cwd, ".git/hooks/pre-push");
    expect(statSync(askpass).mode & 0o111).toBeTruthy();
    expect(statSync(hook).mode & 0o111).toBeTruthy();
    const askpassBody = readFileSync(askpass, "utf8");
    expect(askpassBody).toContain("x-access-token");
    expect(askpassBody).toContain("GH_TOKEN"); // reads the token from env, does not embed one
  });

  test("pre-push hook rejects the default branch but allows a task branch", () => {
    configureForAgent(cwd);
    const hook = join(cwd, ".git/hooks/pre-push");
    const run = (remoteRef: string) =>
      execFileSync("sh", [hook, "origin", "https://github.com/x/y.git"], {
        cwd,
        input: `refs/heads/local abc ${remoteRef} 000\n`,
        stdio: ["pipe", "pipe", "pipe"],
      });

    expect(() => run("refs/heads/main")).toThrow(); // default branch → non-zero exit
    expect(run("refs/heads/sushii-runner/task-1").toString()).toBe(""); // task branch → allowed
  });
});
