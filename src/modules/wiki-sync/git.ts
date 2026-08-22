import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";

const logger = getLogger("wiki-sync:git");

const COMMITTER_NAME = "sushii-wiki-sync";
const COMMITTER_EMAIL = "wiki-sync@sushii.bot";

export interface WikiRepo {
  dir: string;
  git: SimpleGit;
}

interface GitAuth {
  env: Record<string, string>;
  /** git config key/value pairs (e.g. http.extraHeader) applied both at clone time and after. */
  configPairs: Array<[string, string]>;
}

// Wrapped in `timeout` rather than relying on ssh's own ConnectTimeout: verified directly
// (against git.dreamcatcher.inc, from both a dev machine and the actual production host) that
// ConnectTimeout does NOT bound this failure mode -- a Cloudflare-fronted host can accept the
// TCP connection and then hang forever on the SSH protocol banner exchange, which
// ConnectTimeout never sees. Without a hard outer timeout an unreachable host hangs
// indefinitely, and since sweep.ts's inFlight guard only releases once this resolves, a single
// hung push would silently block every future sweep for that guild until the process restarts.
const SSH_COMMAND = `timeout 30 ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15`;

/**
 * Resolves auth for either transport a wiki repo URL might use -- some git hosts behind
 * Cloudflare's proxy only forward HTTP(S), not raw SSH, so both need to work.
 *
 * ssh://  -- the private key is never read by this process; it's loaded into ssh-agent by the
 *            container entrypoint before this process starts (see docker-entrypoint.sh),
 *            specifically so the key never exists as a file this process's own filesystem
 *            tools could open (Pi's read/grep/find have no sandbox -- see piSession.ts). Only
 *            the agent socket is needed here.
 * https:// -- token passed via an http.extraHeader git config value, not embedded in the URL
 *            (repoUrl flows into notify.ts's commit-link derivation and gets logged; a
 *            credential embedded in the URL itself would leak into both).
 */
export function resolveGitAuth(repoUrl: string): GitAuth {
  const scheme = new URL(repoUrl).protocol;

  if (scheme === "ssh:") {
    if (!process.env["SSH_AUTH_SOCK"]) {
      throw new Error("wiki-sync repo URL is ssh:// but no push key is loaded into ssh-agent (SSH_AUTH_SOCK not set)");
    }
    return { env: { GIT_SSH_COMMAND: SSH_COMMAND }, configPairs: [] };
  }

  if (scheme === "https:" || scheme === "http:") {
    if (!config.wikiSync.httpsToken) {
      throw new Error("wiki-sync repo URL is http(s):// but WIKI_SYNC_HTTPS_TOKEN is not set");
    }
    const authHeader = `Authorization: Basic ${Buffer.from(`oauth2:${config.wikiSync.httpsToken}`).toString("base64")}`;
    return { env: {}, configPairs: [["http.extraHeader", authHeader]] };
  }

  throw new Error(`wiki-sync repo URL has an unsupported scheme: ${scheme}`);
}

function requireRepoUrl(): string {
  const { repoUrl } = config.wikiSync;
  if (!repoUrl) throw new Error("wiki-sync is not configured: set WIKI_SYNC_REPO_URL");
  return repoUrl;
}

/** Clones the wiki repo for this guild if it doesn't exist locally yet, then pulls latest. */
export async function openWikiRepo(guildId: string): Promise<WikiRepo> {
  const repoUrl = requireRepoUrl();
  const auth = resolveGitAuth(repoUrl);
  const dir = join(config.wikiSync.cloneDir, guildId);
  await mkdir(dirname(dir), { recursive: true });

  const alreadyCloned = existsSync(join(dir, ".git"));

  if (!alreadyCloned) {
    logger.info({ guildId, dir }, "cloning wiki repo");
    const cloneArgs = auth.configPairs.flatMap(([key, value]) => ["--config", `${key}=${value}`]);
    await simpleGit({ baseDir: dirname(dir) })
      .env({ ...process.env, ...auth.env })
      .clone(repoUrl, dir, cloneArgs);
  }

  const git = simpleGit({ baseDir: dir }).env({ ...process.env, ...auth.env });

  // Applied again even right after a fresh clone (redundant with the --config clone args, but
  // cheap) so an existing checkout whose config predates a scheme/token change stays correct.
  for (const [key, value] of auth.configPairs) {
    await git.addConfig(key, value);
  }

  if (alreadyCloned) {
    logger.info({ guildId, dir }, "pulling wiki repo");
    await git.fetch();
    await git.reset(["--hard", "origin/HEAD"]);
  }

  await git.addConfig("user.name", COMMITTER_NAME);
  await git.addConfig("user.email", COMMITTER_EMAIL);

  return { dir, git };
}

/** Stages everything, commits (no-ops if nothing changed), and pushes. Returns the commit sha, or null if there was nothing to commit. */
export async function commitAndPush(repo: WikiRepo, message: string): Promise<string | null> {
  await repo.git.add(["-A"]);
  const status = await repo.git.status();
  if (status.files.length === 0) {
    return null;
  }
  const result = await repo.git.commit(message);
  await repo.git.push("origin", "HEAD");
  return result.commit;
}
