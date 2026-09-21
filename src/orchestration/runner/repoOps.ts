import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
 *  never here — the agent cannot mint tokens for any other repo. */
export function agentGitEnv(cwd: string, token: string): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_ASKPASS: join(cwd, ASKPASS_REL),
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
  configureForAgent(cwd);
  log.info({ cwd, repo: `${spec.owner}/${spec.repo}` }, "cloned repo on-demand");
  return true;
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
