import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { getLogger } from "../../logger.ts";
import type { RepoSpec } from "../contracts.ts";
import type { GitTokenProvider } from "./githubApp.ts";

const log = getLogger("orchestration.runner.repoOps");
const GITHUB_API = "https://api.github.com";

export interface BotIdentity {
  name: string;
  email: string;
}

export interface RepoOpsDeps {
  provider: GitTokenProvider;
  bot: BotIdentity;
  fetchImpl?: typeof fetch;
  gitFactory?: (cwd?: string) => SimpleGit;
}

function cleanUrl(spec: RepoSpec): string {
  return `https://github.com/${spec.owner}/${spec.repo}.git`;
}

// Token embedded for a single git invocation. The credential rides the URL rather than .git/config
// or the git subprocess env (simple-git blocks env-based config injection). After clone the remote
// is reset to the clean URL, so the token never persists in the semi-durable checkout; for push it
// is passed inline and never written anywhere. It is transiently visible in the runner's process
// args — acceptable on the owner-only single-tenant container, and Tier 2 isolates per principal.
function authUrl(spec: RepoSpec, token: string): string {
  return `https://x-access-token:${token}@github.com/${spec.owner}/${spec.repo}.git`;
}

// Inject the token into an https remote for a single push; leave any other transport (a local
// file:// remote, as in tests) untouched so it needs no credential.
function tokenizeHttps(url: string, token: string): string {
  return url.startsWith("https://") ? url.replace(/^https:\/\/([^@]*@)?/, `https://x-access-token:${token}@`) : url;
}

async function setIdentity(git: SimpleGit, bot: BotIdentity): Promise<void> {
  await git.addConfig("user.name", bot.name);
  await git.addConfig("user.email", bot.email);
}

/** Clone owner/repo into `cwd` if it is not already a checkout. Returns true if a clone happened. */
export async function cloneIfAbsent(cwd: string, spec: RepoSpec, deps: RepoOpsDeps): Promise<boolean> {
  if (existsSync(join(cwd, ".git"))) return false;
  mkdirSync(dirname(cwd), { recursive: true });
  const { token } = await deps.provider.tokenFor(spec);
  const factory = deps.gitFactory ?? simpleGit;
  await factory().clone(authUrl(spec, token), cwd);
  const wc = factory(cwd);
  await wc.remote(["set-url", "origin", cleanUrl(spec)]); // scrub the token out of persisted config
  await setIdentity(wc, deps.bot);
  log.info({ cwd, repo: `${spec.owner}/${spec.repo}` }, "cloned repo on-demand");
  return true;
}

export interface PushResult {
  branch: string;
  prUrl: string;
}

// Runner-side handback: commit the agent's working-tree changes onto a task branch, push it, open a
// draft PR against the repo's default branch. The agent never holds the credential and never pushes
// directly — this is the only place a push happens, and it targets a task branch, never the default,
// so "branch-only" is enforced by construction. Returns null when there is nothing to push.
export async function pushWorkAndOpenPr(
  cwd: string,
  spec: RepoSpec,
  task: { taskId: string; summary: string; startSha: string | null },
  deps: RepoOpsDeps,
): Promise<PushResult | null> {
  const git = (deps.gitFactory ?? simpleGit)(cwd);
  await setIdentity(git, deps.bot); // resume may reach a checkout cloneIfAbsent did not configure

  const status = await git.status();
  const headBefore = (await git.revparse(["HEAD"]).catch(() => null))?.trim() ?? null;
  const hasWorkingChanges = status.files.length > 0;
  // A new commit relative to where the task started; falls back to "any history" when startSha is
  // unknown (a repo with no commits at dispatch).
  const hasNewCommits = task.startSha ? headBefore !== null && headBefore !== task.startSha : (await git.log()).total > 0;
  if (!hasWorkingChanges && !hasNewCommits) return null; // agent changed nothing — no empty PR

  const branch = `sushii-runner/${task.taskId}`;
  await git.checkout(["-B", branch]);
  if (hasWorkingChanges) {
    await git.add(["-A"]);
    await git.commit(firstLine(task.summary) || `runner task ${task.taskId}`);
  }

  const { token } = await deps.provider.tokenFor(spec); // fresh token at push time (may be ~1h later)
  const originUrl = (await git.remote(["get-url", "origin"]))?.trim() ?? cleanUrl(spec);
  await git.push([tokenizeHttps(originUrl, token), `HEAD:refs/heads/${branch}`]);
  const prUrl = await openPr(spec, branch, task, token, deps);
  log.info({ cwd, branch, prUrl }, "pushed task branch + opened PR");
  return { branch, prUrl };
}

async function openPr(
  spec: RepoSpec,
  branch: string,
  task: { taskId: string; summary: string },
  token: string,
  deps: RepoOpsDeps,
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const base = await defaultBranch(spec, token, fetchImpl);
  const payload = {
    title: firstLine(task.summary) || `Runner task ${task.taskId}`,
    head: branch,
    base,
    body: task.summary || "",
    draft: true,
  };
  let res = await fetchImpl(`${GITHUB_API}/repos/${spec.owner}/${spec.repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  // Some repos/plans reject draft PRs (422) — retry non-draft rather than fail the handback.
  if (res.status === 422) {
    res = await fetchImpl(`${GITHUB_API}/repos/${spec.owner}/${spec.repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, draft: false }),
    });
  }
  if (!res.ok) throw new Error(`open PR for ${spec.owner}/${spec.repo} failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { html_url: string };
  return body.html_url;
}

async function defaultBranch(spec: RepoSpec, token: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`${GITHUB_API}/repos/${spec.owner}/${spec.repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`resolve default branch for ${spec.owner}/${spec.repo} failed: ${res.status}`);
  return ((await res.json()) as { default_branch: string }).default_branch;
}

function firstLine(s: string): string {
  const line = (s ?? "").split("\n")[0]?.trim() ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}
