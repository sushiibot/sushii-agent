import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SimpleGit } from "simple-git";
import { getLogger } from "../../logger.ts";
import { runnerGit } from "../../agentRuntime/runnerGit.ts";
import type { GitTokenProvider, RepoSpec } from "./githubApp.ts";

const log = getLogger("orchestration.github.repoOps");

export interface BotIdentity {
  name: string;
  email: string;
}

export interface RepoOpsDeps {
  provider: GitTokenProvider;
  bot: BotIdentity;
  gitFactory?: (cwd?: string) => SimpleGit;
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

// A GIT_ASKPASS helper answering the App username and $GH_TOKEN (the token arrives per shell; none
// is written here). git's prompt names the URL it will send the answer to, after any insteadOf or
// pushurl rewrite. Only the two exact github.com prompts get an answer, so no port, path
// (credential.useHttpPath) or crafted userinfo can stretch a match onto another host.
const ASKPASS_SCRIPT = `#!/bin/sh
[ -n "\${GH_TOKEN}" ] || exit 1
case "$1" in
  "Username for 'https://github.com': ") echo "x-access-token" ;;
  "Password for 'https://x-access-token@github.com': ") echo "\${GH_TOKEN}" ;;
  *) exit 1 ;;
esac
`;

const ALWAYS_PROTECTED = ["main", "master"];
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

// pre-push guard: refuse a push to main, master, the default branch resolved at install time, or the
// live origin/HEAD. This catches an agent that wanders into `git push origin main`. It is NOT an
// adversarial control — `git push --no-verify` skips it — so the authoritative "no direct push to
// the default branch" guarantee is GitHub branch protection on the repo. This hook guards accidents.
function prePushHook(defaultBranch?: string | null): string {
  const branches = [...new Set([...ALWAYS_PROTECTED, ...(defaultBranch && SAFE_BRANCH_RE.test(defaultBranch) ? [defaultBranch] : [])])];
  return `#!/bin/sh
protected="${branches.join(" ")}"
live=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
[ -n "$live" ] && protected="$protected $live"
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  for b in $protected; do
    if [ "$remote_ref" = "refs/heads/$b" ]; then
      echo "sushii-agent: refusing to push to the default branch ($b). Use a task branch + PR." >&2
      exit 1
    fi
  done
done
exit 0
`;
}

/** Env to inject into the agent's shell so its own git/gh authenticate as the bot, scoped
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
  const factory = deps.gitFactory ?? runnerGit;
  await factory().clone(authUrl(spec, token), cwd);
  const wc = factory(cwd);
  await wc.remote(["set-url", "origin", cleanUrl(spec)]); // scrub the token out of persisted config
  await setIdentity(wc, deps.bot);
  // Keep the shared clone on a DETACHED HEAD so it never holds a named branch — otherwise a
  // `worktree add -B <branch>` collides with a branch checked out here. Agents work in worktrees;
  // this clone is just the object store + a default-tip checkout.
  await wc.raw(["checkout", "--detach"]);
  const head = (await wc.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  configureForAgent(cwd, head.replace(/^origin\//, "") || null);
  log.info({ cwd, repo: `${spec.owner}/${spec.repo}` }, "cloned repo on-demand");
  return true;
}

/** (Re)write the askpass helper + pre-push guard into a checkout. Idempotent, so an existing checkout
 *  can be brought up to date. */
export function configureForAgent(cwd: string, defaultBranch?: string | null): void {
  installAskpass(join(cwd, ASKPASS_REL));
  installPrePushGuard(join(cwd, ".git"), defaultBranch);
}

/** Write the GIT_ASKPASS helper to `path`. It holds no secret: it echoes $GH_TOKEN. */
export function installAskpass(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ASKPASS_SCRIPT);
  chmodSync(path, 0o755);
}

/** Write the default-branch pre-push guard into `gitDir` (a repo's common git dir), protecting main,
 *  master and `defaultBranch`. Returns false when it was already there, so a caller can skip the write. */
export function installPrePushGuard(gitDir: string, defaultBranch?: string | null): boolean {
  const hook = join(gitDir, "hooks", "pre-push");
  const body = prePushHook(defaultBranch);
  if (existsSync(hook) && readFileSync(hook, "utf8") === body) return false;
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, body);
  chmodSync(hook, 0o755);
  return true;
}
