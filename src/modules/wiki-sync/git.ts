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

function requireGitConfig(): { repoUrl: string } {
  const { wikiSyncRepoUrl: repoUrl } = config;
  // The push credential is never read by this process — it's loaded into ssh-agent by the
  // container entrypoint before this process starts (see docker-entrypoint.sh), specifically
  // so the private key never exists as a file this process's own filesystem tools could open
  // (Pi's read/grep/find tools have no sandbox — see piSession.ts). We only need the agent socket.
  if (!repoUrl || !process.env["SSH_AUTH_SOCK"]) {
    throw new Error("wiki-sync is not configured: set WIKI_SYNC_REPO_URL and load a push key into ssh-agent (SSH_AUTH_SOCK not set)");
  }
  return { repoUrl };
}

/** Clones the wiki repo for this guild if it doesn't exist locally yet, then pulls latest. */
export async function openWikiRepo(guildId: string): Promise<WikiRepo> {
  const { repoUrl } = requireGitConfig();
  const dir = join(config.wikiSyncCloneDir, guildId);
  await mkdir(dirname(dir), { recursive: true });

  // No -i <path>: auth comes from ssh-agent via SSH_AUTH_SOCK (inherited from process.env below).
  //
  // Wrapped in `timeout` rather than relying on ssh's own ConnectTimeout: verified directly
  // (against this exact host) that ConnectTimeout does NOT bound this failure mode -- it only
  // covers the TCP handshake, but a Cloudflare-fronted host can accept the TCP connection and
  // then hang forever on the SSH protocol banner exchange, which ConnectTimeout never sees.
  // Without a hard outer timeout, an unreachable git host hangs indefinitely, and since
  // sweep.ts's inFlight guard only releases when this call resolves, a single hung push
  // silently blocks every future sweep for that guild.
  const sshCommand = `timeout 30 ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15`;
  const alreadyCloned = existsSync(join(dir, ".git"));

  if (!alreadyCloned) {
    logger.info({ guildId, dir }, "cloning wiki repo");
    await simpleGit({ baseDir: dirname(dir) })
      .env({ ...process.env, GIT_SSH_COMMAND: sshCommand })
      .clone(repoUrl, dir);
  }

  const git = simpleGit({ baseDir: dir }).env({ ...process.env, GIT_SSH_COMMAND: sshCommand });

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
