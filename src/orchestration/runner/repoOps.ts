import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { getLogger } from "../../logger.ts";
import type { RepoSpec } from "../contracts.ts";
import type { GitTokenProvider } from "./githubApp.ts";

const log = getLogger("orchestration.runner.repoOps");

export interface BotIdentity {
  name: string;
  email: string;
}

export interface RepoOpsDeps {
  provider: GitTokenProvider;
  bot: BotIdentity;
  gitFactory?: (cwd?: string) => SimpleGit;
  fetchImpl?: typeof fetch; // for the merged-PR check in pruneWorktrees; defaults to global fetch
}

function cleanUrl(spec: RepoSpec): string {
  return `https://github.com/${spec.owner}/${spec.repo}.git`;
}

// Token embedded for the single clone invocation only. After clone the origin is reset to the clean
// URL, so it never persists in the semi-durable checkout; the agent's later pushes authenticate via
// GIT_ASKPASS + GH_TOKEN (see agentGitEnv), not a stored credential.
function authUrl(spec: RepoSpec, token: string): string {
  return `https://x-access-token:${token}@github.com/${spec.owner}/${spec.repo}.git`;
}

const ASKPASS_REL = ".git/sushii-askpass.sh";

// A GIT_ASKPASS helper: git calls it for the username and password prompts; it answers the fixed
// App username and the injected per-repo token. No secret is written — the token arrives via the
// GH_TOKEN env the runner injects per shell (agentGitEnv). Same token authenticates `gh`.
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "\${GH_TOKEN}" ;;
esac
`;

// pre-push guard: refuse a push whose target is the repo's default branch, resolved live from
// origin/HEAD. This catches an agent that wanders into \`git push origin main\`. It is NOT an
// adversarial control — \`git push --no-verify\` skips it — so the authoritative "no direct push to
// the default branch" guarantee is GitHub branch protection on the repo. This hook guards accidents.
const PRE_PUSH_HOOK = `#!/bin/sh
default=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
[ -z "$default" ] && default=main
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  if [ "$remote_ref" = "refs/heads/$default" ]; then
    echo "sushii-runner: refusing to push to the default branch ($default). Use a task branch + PR." >&2
    exit 1
  fi
done
exit 0
`;

/** Env the runner injects into the agent's shell so its own git/gh authenticate as the bot, scoped
 *  to this repo. The token is readable by the agent (accepted: repo-scoped, ~1h) but the App key is
 *  never here — the agent cannot mint tokens for any other repo. `repoHome` is the shared clone (its
 *  real .git holds the askpass helper); a worktree's own .git is a file, so the helper can't live
 *  there. */
export function agentGitEnv(repoHome: string, token: string): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_ASKPASS: join(repoHome, ASKPASS_REL),
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function setIdentity(git: SimpleGit, bot: BotIdentity): Promise<void> {
  await git.addConfig("user.name", bot.name);
  await git.addConfig("user.email", bot.email);
}

/** Clone owner/repo into `cwd` if absent, then configure it for agent-driven git: clean origin, bot
 *  commit identity, the GIT_ASKPASS helper, and the default-branch pre-push guard. Returns true if a
 *  clone happened. */
export async function cloneIfAbsent(cwd: string, spec: RepoSpec, deps: RepoOpsDeps): Promise<boolean> {
  if (existsSync(join(cwd, ".git"))) return false;
  mkdirSync(dirname(cwd), { recursive: true });
  const { token } = await deps.provider.tokenFor(spec);
  const factory = deps.gitFactory ?? simpleGit;
  await factory().clone(authUrl(spec, token), cwd);
  const wc = factory(cwd);
  await wc.remote(["set-url", "origin", cleanUrl(spec)]); // scrub the token out of persisted config
  await setIdentity(wc, deps.bot);
  // Keep the shared clone on a DETACHED HEAD so it never holds a named branch — otherwise
  // `worktree add -B sushii-runner/<id>` collides with a branch checked out here. Agents only ever
  // run in worktrees; this clone is just the object store + a default-tip checkout.
  await wc.raw(["checkout", "--detach"]);
  configureForAgent(cwd);
  log.info({ cwd, repo: `${spec.owner}/${spec.repo}` }, "cloned repo on-demand");
  return true;
}

/** Per-task worktree off the shared clone, on a fresh `sushii-runner/<taskId>` branch cut from the
 *  latest default. Each task is isolated — its own working tree + branch — so concurrent or repeat
 *  tasks on one repo never share state. Reused as-is on resume. Returns the worktree path. */
export async function ensureWorktree(repoHome: string, taskId: string, deps: RepoOpsDeps): Promise<string> {
  const worktreePath = `${repoHome}.wt/${taskId}`;
  const git = (deps.gitFactory ?? simpleGit)(repoHome);
  // Reuse only a worktree git actually knows about — a bare directory (crashed `worktree add`,
  // orphaned leftover) is not a valid resume target. `worktree list` is the source of truth.
  const list = await git.raw(["worktree", "list", "--porcelain"]).catch(() => "");
  if (list.split("\n").some((l) => l === `worktree ${worktreePath}`)) return worktreePath;
  if (existsSync(worktreePath)) {
    await git.raw(["worktree", "prune"]).catch(() => {}); // drop stale bookkeeping
    rmSync(worktreePath, { recursive: true, force: true }); // clear the leftover dir
  }
  // The shared clone must hold no named branch, or `worktree add -B <branch>` collides with it.
  // Self-heals a clone left on a task branch by an older layout (fresh clones are already detached).
  const onBranch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim();
  if (onBranch !== "HEAD") await git.raw(["checkout", "--detach"]).catch(() => {});
  await git.fetch(["origin"]);
  const head = (await git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  const base = head.replace(/^origin\//, "") || "main";
  mkdirSync(dirname(worktreePath), { recursive: true });
  await git.raw(["worktree", "add", "--force", "-B", `sushii-runner/${taskId}`, worktreePath, `origin/${base}`]);
  log.info({ repoHome, worktreePath, base }, "created task worktree");
  return worktreePath;
}

/** Remove a task's worktree (discard). Best-effort: `git worktree remove --force`, then rmSync the dir
 *  and prune bookkeeping. Only ever called for clone-on-demand worktrees under `<repoHome>.wt/`. */
export async function removeWorktree(repoHome: string, taskId: string, deps: RepoOpsDeps): Promise<void> {
  const worktreePath = `${repoHome}.wt/${taskId}`;
  const git = (deps.gitFactory ?? simpleGit)(repoHome);
  await git.raw(["worktree", "remove", "--force", worktreePath]).catch(() => {});
  if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  await git.raw(["worktree", "prune"]).catch(() => {});
  log.info({ repoHome, worktreePath }, "removed task worktree (discard)");
}

function originSpecOf(git: SimpleGit): Promise<RepoSpec | null> {
  return git
    .remote(["get-url", "origin"])
    .then((url) => {
      const m = url?.trim().match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
      return m ? { owner: m[1], repo: m[2] } : null;
    })
    .catch(() => null);
}

async function isPrMerged(spec: RepoSpec, branch: string, deps: RepoOpsDeps): Promise<boolean> {
  try {
    const { token } = await deps.provider.tokenFor(spec);
    const res = await (deps.fetchImpl ?? fetch)(
      `https://api.github.com/repos/${spec.owner}/${spec.repo}/pulls?head=${spec.owner}:${branch}&state=all&per_page=10`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return false;
    return ((await res.json()) as Array<{ merged_at: string | null }>).some((p) => p.merged_at != null);
  } catch {
    return false;
  }
}

/** GC task worktrees under `workspaceRoot`: remove one whose PR has already merged (eager), or that
 *  has been idle past `ttlMs`. Never touches a worktree whose task is still active. Returns the paths
 *  removed. The shared clones + object stores stay; only the per-task working trees are reclaimed. */
export async function pruneWorktrees(opts: {
  workspaceRoot: string;
  ttlMs: number;
  activeTaskIds: Set<string>;
  deps: RepoOpsDeps;
  now?: () => number;
}): Promise<string[]> {
  const { workspaceRoot, ttlMs, activeTaskIds, deps } = opts;
  const now = opts.now ?? Date.now;
  const removed: string[] = [];
  if (!existsSync(workspaceRoot)) return removed;
  const factory = deps.gitFactory ?? simpleGit;

  const dirs = (base: string) => {
    try {
      return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };

  for (const principal of dirs(workspaceRoot)) {
    const pdir = join(workspaceRoot, principal.name);
    for (const entry of dirs(pdir)) {
      if (!entry.name.endsWith(".wt")) continue;
      const wtContainer = join(pdir, entry.name);
      const repoHome = wtContainer.slice(0, -3); // strip ".wt"
      if (!existsSync(join(repoHome, ".git"))) continue;
      const git = factory(repoHome);
      const spec = await originSpecOf(git);
      let prunedAny = false;
      for (const wt of dirs(wtContainer)) {
        const taskId = wt.name;
        if (activeTaskIds.has(taskId)) continue;
        const wtPath = join(wtContainer, taskId);
        const expired = now() - statSync(wtPath).mtimeMs > ttlMs;
        const remove = expired || (spec ? await isPrMerged(spec, `sushii-runner/${taskId}`, deps) : false);
        if (!remove) continue;
        await git.raw(["worktree", "remove", "--force", wtPath]).catch(() => rmSync(wtPath, { recursive: true, force: true }));
        removed.push(wtPath);
        prunedAny = true;
      }
      if (prunedAny) await git.raw(["worktree", "prune"]).catch(() => {});
    }
  }
  return removed;
}

/** (Re)write the askpass helper + pre-push guard into a checkout. Idempotent — also called on resume
 *  so a checkout cloned by an older build gains them. */
export function configureForAgent(cwd: string): void {
  const askpass = join(cwd, ASKPASS_REL);
  writeFileSync(askpass, ASKPASS_SCRIPT);
  chmodSync(askpass, 0o755);
  const hook = join(cwd, ".git/hooks/pre-push");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, PRE_PUSH_HOOK);
  chmodSync(hook, 0o755);
}
