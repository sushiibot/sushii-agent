import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { GITHUB_REPO_RE, RPC_METHODS, type GitHubTokenResult } from "../orchestration/contracts.ts";
import { installAskpass, installPrePushGuard } from "../orchestration/github/repoOps.ts";
import { runnerGitEnv } from "../agentRuntime/runnerGit.ts";
import { getLogger } from "../logger.ts";

/** A cached token is re-requested this long before it expires. */
export const REFRESH_SLACK_MS = 5 * 60_000;
/** After a failed fetch, bash calls for that repo run without a token for this long before asking again. */
export const FAILURE_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 2_000;
const DEFAULT_BRANCH_TIMEOUT_MS = 5_000;
const GITHUB_API = "https://api.github.com";

type Log = { warn(obj: object, msg: string): void; info(obj: object, msg: string): void };

export interface GitHubCredentialsOptions {
  principalId: string;
  home: string;
  /** Where the shared GIT_ASKPASS helper is written; outside `projects/` so the subagent watch never sees it. */
  askpassPath: string;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /** Taken around a pre-push hook install, so the subagent watch doesn't count it as a writer's tamper. */
  leaseWrite?: (homeRelPaths: string[]) => () => void;
  now?: () => number;
  log?: Log;
  /** Test seam: runs `git <args>` in `cwd` (with `env` on top of the runner env) and returns trimmed stdout, or null on any failure. */
  git?: (cwd: string, args: string[], env?: Record<string, string>) => Promise<string | null>;
  /** Test seam for the GitHub API default-branch lookup. */
  fetchImpl?: typeof fetch;
}

type Grant = { token: string; expiresAt: number; botName: string; botEmail: string };

function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<string | null> {
  return new Promise((done) => {
    const timeout = env ? DEFAULT_BRANCH_TIMEOUT_MS : GIT_TIMEOUT_MS;
    execFile("git", ["-C", cwd, ...args], { env: { ...runnerGitEnv(), ...env }, timeout }, (err, stdout) => done(err ? null : stdout.trim()));
  });
}

function asRepo(owner: string, name: string): string | null {
  const repo = `${owner}/${name.replace(/\.git$/, "")}`;
  return GITHUB_REPO_RE.test(repo) ? repo : null;
}

/** owner/name of a github.com remote URL (https, ssh or scp-style), else null. */
export function repoFromRemoteUrl(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[/:]([^/]+)\/([^/]+?)\/?$/i.exec(url.trim());
  return m ? asRepo(m[1]!, m[2]!) : null;
}

const NAME = "([A-Za-z0-9-]+)\\/([A-Za-z0-9._-]+)";
// No subdomain or word char before github.com, so api.github.com/repos/o/n isn't read as owner "repos".
const URL_RE = new RegExp(`(?<![\\w.-])github\\.com[/:]${NAME}`, "i");
const CLONE_RE = new RegExp(`\\bgh\\s+repo\\s+clone\\s+["']?${NAME}`);
const REPO_FLAG_RE = new RegExp(`(?:^|\\s)(?:-R\\s*|--repo[=\\s]\\s*)["']?${NAME}`);
const GH_RE = /(?:^|[\s;&|(])gh\s/;

/** The repo a command names: a github.com URL, `gh repo clone owner/name`, or a `gh` `-R`/`--repo owner/name`.
 *  Anything else (`gh api repos/o/n`, `GH_REPO=`, `git -C dir`, ssh with a port, www.github.com) finds no
 *  repo and runs without a token, so a miss fails auth rather than using the wrong repo's token. */
export function repoFromCommand(command: string): string | null {
  for (const re of [URL_RE, CLONE_RE]) {
    const m = re.exec(command);
    const repo = m && asRepo(m[1]!, m[2]!);
    if (repo) return repo;
  }
  // -R is also cp/chmod's recursive flag; only a gh command's -R names a repo.
  if (GH_RE.test(command)) {
    const m = REPO_FLAG_RE.exec(command);
    const repo = m && asRepo(m[1]!, m[2]!);
    if (repo) return repo;
  }
  return null;
}

/** Where a command runs: its leading `cd <dir> &&|;` when the dir exists, else the tool's cwd. */
export function effectiveCwd(command: string, cwd: string, home: string): string {
  const m = /^\s*cd\s+(["']?)([^"'\s;&|]+)\1\s*(?:&&|;)/.exec(command);
  if (!m) return cwd;
  const raw = m[2]!;
  const dir = raw === "~" ? home : raw.startsWith("~/") ? resolve(home, raw.slice(2)) : resolve(cwd, raw);
  try {
    return statSync(dir).isDirectory() ? dir : cwd;
  } catch {
    return cwd;
  }
}

/**
 * Per-bash-call GitHub credentials: finds the repo a command works on, fetches a repo-scoped App token from
 * the bot (cached until shortly before expiry), and returns the env that makes git and gh use it. A failed
 * fetch returns no env; the command then fails with git's usual auth error.
 */
export class GitHubCredentials {
  private readonly now: () => number;
  private readonly log: Log;
  private readonly git: (cwd: string, args: string[], env?: Record<string, string>) => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly grants = new Map<string, Grant>();
  private readonly inflight = new Map<string, Promise<Grant | null>>();
  private readonly failedUntil = new Map<string, number>();
  /** Checkout dirs already resolved, and the git dirs whose guard is in place. */
  private readonly checked = new Set<string>();
  private readonly guarded = new Set<string>();
  private askpassReady = false;

  constructor(private readonly opts: GitHubCredentialsOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? getLogger("workspace.github");
    this.git = opts.git ?? runGit;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The repo a bash call works on: the cwd's github.com origin, else one the command names. */
  async repoFor(command: string, cwd: string): Promise<{ repo: string; localDir: string | null } | null> {
    const dir = effectiveCwd(command, cwd, this.opts.home);
    const origin = existsSync(dir) ? await this.git(dir, ["remote", "get-url", "origin"]) : null;
    const fromRemote = origin ? repoFromRemoteUrl(origin) : null;
    if (fromRemote) return { repo: fromRemote, localDir: dir };
    const named = repoFromCommand(command);
    return named ? { repo: named, localDir: null } : null;
  }

  /** Env for one bash call; empty when no repo is found or the token can't be had. Never throws. */
  async envFor(command: string, cwd: string): Promise<Record<string, string>> {
    try {
      const target = await this.repoFor(command, cwd);
      if (!target) return {};
      const grant = await this.grant(target.repo);
      if (!grant) return {};
      if (!this.askpassReady) {
        installAskpass(this.opts.askpassPath);
        this.askpassReady = true;
      }
      if (target.localDir) await this.guard(target.localDir, target.repo, grant.token);
      return {
        ...this.authEnv(grant.token),
        GIT_AUTHOR_NAME: grant.botName,
        GIT_AUTHOR_EMAIL: grant.botEmail,
        GIT_COMMITTER_NAME: grant.botName,
        GIT_COMMITTER_EMAIL: grant.botEmail,
      };
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "github credentials: failed; running without them");
      return {};
    }
  }

  /** git/gh auth for one token. Only the askpass helper answers credential prompts: the config reset
   *  drops any credential.helper (which git would also hand the token to on success). */
  private authEnv(token: string): Record<string, string> {
    return {
      GH_TOKEN: token,
      GIT_ASKPASS: this.opts.askpassPath,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    };
  }

  private async grant(repo: string): Promise<Grant | null> {
    const key = repo.toLowerCase();
    const cached = this.grants.get(key);
    if (cached && cached.expiresAt - this.now() > REFRESH_SLACK_MS) return cached;
    if ((this.failedUntil.get(key) ?? 0) > this.now()) return null;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetch(repo, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async fetch(repo: string, key: string): Promise<Grant | null> {
    let error: string;
    try {
      const res = (await this.opts.request(RPC_METHODS.githubToken, { principalId: this.opts.principalId, repo }, REQUEST_TIMEOUT_MS)) as GitHubTokenResult | undefined;
      if (res?.ok && typeof res.token === "string" && typeof res.expiresAt === "number") {
        const grant: Grant = { token: res.token, expiresAt: res.expiresAt, botName: res.botName, botEmail: res.botEmail };
        this.grants.set(key, grant);
        this.failedUntil.delete(key);
        return grant;
      }
      error = res && !res.ok ? res.error : "malformed github/token reply";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.failedUntil.set(key, this.now() + FAILURE_BACKOFF_MS);
    this.log.warn({ repo, error }, "github token unavailable; running the command without it");
    return null;
  }

  /** Installs the default-branch pre-push guard in a repo under ~/projects, once per checkout. */
  private async guard(dir: string, repo: string, token: string): Promise<void> {
    if (this.checked.has(dir)) return;
    this.checked.add(dir);
    const common = await this.git(dir, ["rev-parse", "--git-common-dir"]);
    if (!common) return;
    let gitDir: string;
    let projects: string;
    let home: string;
    try {
      gitDir = realpathSync(resolve(dir, common));
      projects = realpathSync(resolve(this.opts.home, "projects"));
      home = realpathSync(this.opts.home);
    } catch {
      return;
    }
    const rel = relative(projects, gitDir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || this.guarded.has(gitDir)) return;
    this.guarded.add(gitDir);
    const defaultBranch = await this.defaultBranch(dir, repo, token);
    const end = this.opts.leaseWrite?.([`${relative(home, gitDir)}/hooks`]);
    try {
      if (installPrePushGuard(gitDir, defaultBranch)) this.log.info({ gitDir, defaultBranch }, "installed the default-branch pre-push guard");
    } finally {
      end?.();
    }
  }

  /** origin/HEAD, else the remote's HEAD, else the GitHub API; null when all fail (the hook then
   *  still protects main and master). */
  private async defaultBranch(dir: string, repo: string, token: string): Promise<string | null> {
    const local = await this.git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (local) return local.replace(/^origin\//, "");
    const remote = await this.git(dir, ["ls-remote", "--symref", "origin", "HEAD"], this.authEnv(token));
    const m = remote && /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote);
    if (m) return m[1]!;
    try {
      const res = await this.fetchImpl(`${GITHUB_API}/repos/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(DEFAULT_BRANCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { default_branch?: unknown };
        if (typeof body.default_branch === "string" && body.default_branch) return body.default_branch;
      }
    } catch {
      // fall through: main and master stay protected
    }
    this.log.warn({ repo }, "could not resolve the default branch; the pre-push guard protects main and master");
    return null;
  }
}
