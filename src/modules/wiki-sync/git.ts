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

function requireGitConfig(): { repoUrl: string; deployKeyPath: string } {
  const { wikiSyncRepoUrl: repoUrl, wikiSyncDeployKeyPath: deployKeyPath } = config;
  if (!repoUrl || !deployKeyPath) {
    throw new Error(
      "wiki-sync is not configured: set WIKI_SYNC_REPO_URL and WIKI_SYNC_DEPLOY_KEY_PATH",
    );
  }
  return { repoUrl, deployKeyPath };
}

/** Clones the wiki repo for this guild if it doesn't exist locally yet, then pulls latest. */
export async function openWikiRepo(guildId: string): Promise<WikiRepo> {
  const { repoUrl, deployKeyPath } = requireGitConfig();
  const dir = join(config.wikiSyncCloneDir, guildId);
  await mkdir(dirname(dir), { recursive: true });

  const sshCommand = `ssh -i ${deployKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
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
