import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_METHODS, type GitHubTokenResult } from "../orchestration/contracts.ts";
import { runnerGitEnv } from "../agentRuntime/runnerGit.ts";
import { redact } from "./secretPatterns.ts";
import { createWorkspaceBashTool } from "./piChatSession.ts";
import { FAILURE_BACKOFF_MS, GitHubCredentials, REFRESH_SLACK_MS, effectiveCwd, repoFromCommand, repoFromRemoteUrl, type GitHubCredentialsOptions } from "./githubCredentials.ts";

const TOKEN = "ghs_0123456789abcdefghijABCDEFGHIJ";
const HOUR = 3600_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: runnerGitEnv(), encoding: "utf8" }).trim();
}

function initRepo(dir: string, origin?: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "commit", "--allow-empty", "-m", "init");
  if (origin) git(dir, "remote", "add", "origin", origin);
}

describe("repo detection", () => {
  test("github.com remote URLs in every form; other hosts are not", () => {
    expect(repoFromRemoteUrl("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(repoFromRemoteUrl("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(repoFromRemoteUrl("https://x-access-token:abc@github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(repoFromRemoteUrl("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(repoFromRemoteUrl("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(repoFromRemoteUrl("https://gitlab.com/acme/widgets.git")).toBeNull();
    expect(repoFromRemoteUrl("https://github.com.evil.test/acme/widgets")).toBeNull();
    expect(repoFromRemoteUrl("/srv/git/widgets.git")).toBeNull();
  });

  test("a URL, gh -R/--repo, or gh repo clone in the command", () => {
    expect(repoFromCommand("git clone https://github.com/acme/widgets.git projects/acme-widgets")).toBe("acme/widgets");
    expect(repoFromCommand("git clone git@github.com:acme/widgets projects/acme-widgets")).toBe("acme/widgets");
    expect(repoFromCommand("gh pr list -R acme/widgets")).toBe("acme/widgets");
    expect(repoFromCommand("gh issue view 3 --repo acme/widgets")).toBe("acme/widgets");
    expect(repoFromCommand("gh issue view 3 --repo=acme/widgets")).toBe("acme/widgets");
    expect(repoFromCommand("gh repo clone acme/widgets ~/projects/acme-widgets")).toBe("acme/widgets");
    expect(repoFromCommand("curl https://api.github.com/repos/acme/widgets")).toBeNull();
    expect(repoFromCommand("cp -R src/lib dst")).toBeNull();
    expect(repoFromCommand("gh repo clone widgets")).toBeNull();
    expect(repoFromCommand("ls -la")).toBeNull();
  });

  test("a leading cd sets the directory the remote is read from", () => {
    const home = mkdtempSync(join(tmpdir(), "ghc-cwd-"));
    mkdirSync(join(home, "projects", "a"), { recursive: true });
    try {
      expect(effectiveCwd("cd projects/a && git push", home, home)).toBe(join(home, "projects", "a"));
      expect(effectiveCwd("cd ~/projects/a; git push", "/elsewhere", home)).toBe(join(home, "projects", "a"));
      expect(effectiveCwd("cd projects/missing && git push", home, home)).toBe(home);
      expect(effectiveCwd("git push", home, home)).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the token shape is one our redaction catches", () => {
    expect(redact(`GH_TOKEN=${TOKEN}`)).not.toContain(TOKEN);
  });
});

describe("GitHubCredentials", () => {
  let home: string;
  let state: string;
  let now: number;
  let calls: Array<{ method: string; params: unknown }>;
  let reply: (repo: string) => Promise<GitHubTokenResult>;
  let warns: Array<{ obj: object; msg: string }>;
  let leases: string[][];

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "ghc-"));
    home = join(root, "home");
    state = join(root, "state");
    mkdirSync(join(home, "projects"), { recursive: true });
    now = 1_000_000;
    calls = [];
    warns = [];
    leases = [];
    reply = async () => ({ ok: true, token: TOKEN, expiresAt: now + HOUR, botName: "sushii-runner[bot]", botEmail: "runner@users.noreply.github.com" });
  });

  afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

  function creds(overrides: Partial<GitHubCredentialsOptions> = {}): GitHubCredentials {
    return new GitHubCredentials({
      principalId: "drk",
      home,
      askpassPath: join(state, "git-askpass.sh"),
      request: async (method, params) => {
        calls.push({ method, params });
        return reply((params as { repo: string }).repo);
      },
      leaseWrite: (paths) => {
        leases.push(paths);
        return () => {};
      },
      now: () => now,
      log: { warn: (obj, msg) => warns.push({ obj, msg }), info: () => {} },
      ...overrides,
    });
  }

  test("a repo under projects/ with a github origin gets the token, askpass and bot identity", async () => {
    const repo = join(home, "projects", "acme-widgets");
    initRepo(repo, "https://github.com/acme/widgets.git");
    const env = await creds().envFor("git push -u origin feat", repo);
    expect(calls).toEqual([{ method: RPC_METHODS.githubToken, params: { principalId: "drk", repo: "acme/widgets" } }]);
    expect(env).toEqual({
      GH_TOKEN: TOKEN,
      GIT_ASKPASS: join(state, "git-askpass.sh"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "sushii-runner[bot]",
      GIT_AUTHOR_EMAIL: "runner@users.noreply.github.com",
      GIT_COMMITTER_NAME: "sushii-runner[bot]",
      GIT_COMMITTER_EMAIL: "runner@users.noreply.github.com",
    });
    const askpass = readFileSync(join(state, "git-askpass.sh"), "utf8");
    expect(askpass).toContain("GH_TOKEN");
    expect(askpass).not.toContain(TOKEN);
  });

  test("the pre-push guard is installed once, in the common git dir, under a write lease", async () => {
    const repo = join(home, "projects", "acme-widgets");
    initRepo(repo, "https://github.com/acme/widgets.git");
    const wt = join(home, "projects", "acme-widgets-wt-1");
    git(repo, "worktree", "add", "-b", "feat", wt);
    const c = creds();
    await c.envFor("git status", wt);
    const hook = join(repo, ".git", "hooks", "pre-push");
    expect(statSync(hook).mode & 0o111).toBeTruthy();
    expect(readFileSync(hook, "utf8")).toContain("refusing to push to the default branch");
    expect(leases).toEqual([["projects/acme-widgets/.git/hooks"]]);
    await c.envFor("git status", repo);
    expect(leases).toHaveLength(1);
  });

  test("no hook outside projects/, but the token still goes to a github repo there", async () => {
    const repo = join(home, "scratch", "w");
    initRepo(repo, "git@github.com:acme/widgets.git");
    const env = await creds().envFor("git fetch", repo);
    expect(env.GH_TOKEN).toBe(TOKEN);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(false);
    expect(leases).toEqual([]);
  });

  test("with no repo found nothing is requested or injected", async () => {
    initRepo(home); // the home repo has no origin
    const local = join(home, "projects", "local");
    initRepo(local, "/srv/git/local.git");
    const c = creds();
    expect(await c.envFor("ls -la", home)).toEqual({});
    expect(await c.envFor("git log", local)).toEqual({});
    expect(await c.envFor("echo hi", "/nonexistent-dir")).toEqual({});
    expect(calls).toEqual([]);
  });

  test("the command's repo is used when the cwd has none: clone, -R, and a leading cd", async () => {
    const c = creds();
    expect((await c.envFor("gh repo clone acme/widgets projects/acme-widgets", home)).GH_TOKEN).toBe(TOKEN);
    expect((await c.envFor("gh pr list -R acme/gadgets", home)).GH_TOKEN).toBe(TOKEN);
    const repo = join(home, "projects", "acme-tools");
    initRepo(repo, "https://github.com/acme/tools");
    expect((await c.envFor("cd projects/acme-tools && git push", home)).GH_TOKEN).toBe(TOKEN);
    expect(calls.map((x) => (x.params as { repo: string }).repo)).toEqual(["acme/widgets", "acme/gadgets", "acme/tools"]);
  });

  test("tokens are cached per repo until 5 min before expiry, then refreshed", async () => {
    const c = creds();
    await c.envFor("gh pr list -R acme/widgets", home);
    await c.envFor("gh pr list -R ACME/Widgets", home);
    expect(calls).toHaveLength(1);
    now += HOUR - REFRESH_SLACK_MS + 1;
    reply = async () => ({ ok: true, token: "ghs_refreshedrefreshedrefreshed", expiresAt: now + HOUR, botName: "b", botEmail: "e" });
    expect((await c.envFor("gh pr list -R acme/widgets", home)).GH_TOKEN).toBe("ghs_refreshedrefreshedrefreshed");
    expect(calls).toHaveLength(2);
  });

  test("concurrent calls for one repo share a single request", async () => {
    const c = creds();
    await Promise.all([c.envFor("gh pr list -R acme/widgets", home), c.envFor("gh issue list -R acme/widgets", home)]);
    expect(calls).toHaveLength(1);
  });

  test("a failed fetch returns no env, warns without the token, and backs off before asking again", async () => {
    reply = async () => {
      throw new Error("not connected to the orchestrator");
    };
    const c = creds();
    expect(await c.envFor("gh pr list -R acme/widgets", home)).toEqual({});
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ repo: "acme/widgets", error: "not connected to the orchestrator" });
    expect(await c.envFor("gh pr list -R acme/widgets", home)).toEqual({});
    expect(calls).toHaveLength(1);

    reply = async () => ({ ok: false, error: "the sushii GitHub App is not installed on acme/widgets" });
    now += FAILURE_BACKOFF_MS + 1;
    expect(await c.envFor("gh pr list -R acme/widgets", home)).toEqual({});
    expect(warns[1]!.obj).toMatchObject({ error: "the sushii GitHub App is not installed on acme/widgets" });
    expect(JSON.stringify(warns)).not.toContain(TOKEN);
  });

  test("bash runs with the injected env, and still runs when the fetch fails", async () => {
    const repo = join(home, "projects", "acme-widgets");
    initRepo(repo, "https://github.com/acme/widgets.git");
    const run = async (c: GitHubCredentials) => {
      const tool = await createWorkspaceBashTool(repo, () => null, c);
      const res = await tool.execute("call-1", { command: 'printf "%s|%s|%s" "$GH_TOKEN" "$GIT_AUTHOR_NAME" "$GIT_ASKPASS"' }, undefined, undefined, undefined as never);
      return (res.content as Array<{ text: string }>)[0]!.text;
    };
    expect(await run(creds())).toBe(`${TOKEN}|sushii-runner[bot]|${join(state, "git-askpass.sh")}`);
    reply = async () => ({ ok: false, error: "the GitHub App is not configured on the bot" });
    expect(await run(creds())).toBe("||");
  });

  test("the askpass helper answers git with the injected token", async () => {
    await creds().envFor("gh pr list -R acme/widgets", home);
    const askpass = join(state, "git-askpass.sh");
    const ask = (prompt: string) => execFileSync(askpass, [prompt], { env: { PATH: process.env.PATH, GH_TOKEN: TOKEN }, encoding: "utf8" }).trim();
    expect(ask("Username for 'https://github.com': ")).toBe("x-access-token");
    expect(ask("Password for 'https://x-access-token@github.com': ")).toBe(TOKEN);
  });
});
