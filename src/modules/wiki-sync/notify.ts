import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MessageFlags, type Client } from "discord.js";
import { buildTextDisplayContainer } from "../../agent/delivery.ts";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { WikiRepo } from "./git.ts";

const logger = getLogger("wiki-sync:notify");

const MAX_CONTENT_LENGTH = 3800;

/** ssh://git@host:port/path.git -> https://host/path -- Forgejo and GitHub both serve /commit/<sha> at this shape. */
export function deriveWebUrl(repoUrl: string): string | null {
  const match = repoUrl.match(/^ssh:\/\/git@([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
  if (!match) return null;
  const [, host, path] = match;
  return `https://${host}/${path}`;
}

/**
 * Which daily/<date>.md or weekly/<range>.md files this commit actually touched, oldest
 * first. Not just "today" -- a backlog-catchup sweep can span several calendar days in one
 * commit and files under weekly/ instead (see the wiki's own AGENTS.md "Recap" section).
 */
async function findTouchedRecapFiles(repo: WikiRepo, sha: string): Promise<string[]> {
  const output = await repo.git.raw(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => (line.startsWith("daily/") || line.startsWith("weekly/")) && line.endsWith(".md"))
    .sort();
}

async function buildRecapBody(repo: WikiRepo, commitSha: string): Promise<string | null> {
  const recapFiles = await findTouchedRecapFiles(repo, commitSha).catch(() => []);
  if (recapFiles.length === 0) return null;

  const sections = await Promise.all(
    recapFiles.map(async (relativePath) => {
      const content = await readFile(join(repo.dir, relativePath), "utf8").catch(() => null);
      if (!content) return null;
      // One file: just its content. Multiple (a backfill sweep spanning days): label each.
      return recapFiles.length === 1
        ? content.trim()
        : `**${relativePath.replace(/^(daily|weekly)\/|\.md$/g, "")}**\n${content.trim()}`;
    }),
  );
  const nonEmpty = sections.filter((s): s is string => s !== null);
  return nonEmpty.length > 0 ? nonEmpty.join("\n\n") : null;
}

/** Posts a status update to this guild's configured channel after a sweep pushes a commit. Never throws -- a failed notification shouldn't fail the sweep. */
export async function postSyncStatus(opts: { client: Client; guildId: string; repo: WikiRepo; commitSha: string }): Promise<void> {
  const channelId = config.guildConfig[opts.guildId]?.wiki?.statusChannelId;
  if (!channelId) return;

  try {
    const channel = await opts.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== opts.guildId) {
      logger.error({ guildId: opts.guildId, channelId }, "wikiSyncStatusChannelId is not a guild text channel");
      return;
    }

    const recap = await buildRecapBody(opts.repo, opts.commitSha);

    const webUrl = deriveWebUrl(config.wikiSyncRepoUrl ?? "");
    const commitLine = webUrl
      ? `[View commit](${webUrl}/commit/${opts.commitSha})`
      : `Commit \`${opts.commitSha.slice(0, 7)}\``;

    const body = recap ? `${recap.trim()}\n\n${commitLine}` : commitLine;
    const content = body.length > MAX_CONTENT_LENGTH ? `${body.slice(0, MAX_CONTENT_LENGTH)}…` : body;

    await channel.send({
      components: [buildTextDisplayContainer(content)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    logger.error({ guildId: opts.guildId, channelId, err }, "failed to post wiki-sync status update");
  }
}
