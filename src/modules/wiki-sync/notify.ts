import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type Client } from "discord.js";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { WikiRepo } from "./git.ts";

const logger = getLogger("wiki-sync:notify");

const MAX_CONTENT_LENGTH = 3800;

// Inlined rather than importing agent/delivery.ts's buildTextDisplayContainer: delivery.ts
// pulls in agent/loop.ts, which imports modules/registry.ts, which imports this module's own
// package (wiki-sync/index.ts) -- that closed a real circular-import chain that crash-looped
// the whole process in production (ReferenceError: Cannot access 'wikiSyncModule' before
// initialization). This two-line helper isn't worth reintroducing that dependency for.
function buildTextDisplayContainer(content: string): ContainerBuilder {
  return new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder({ content }));
}

/**
 * Web URL for linking to a commit -- Forgejo and GitHub both serve /commit/<sha> at
 * https://host/path, regardless of which transport wiki-sync itself pushes over.
 *   ssh://git@host:port/path.git -> https://host/path
 *   https://host/path.git        -> https://host/path (strip .git, drop any embedded credentials)
 */
export function deriveWebUrl(repoUrl: string): string | null {
  const sshMatch = repoUrl.match(/^ssh:\/\/git@([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    return `https://${host}/${path}`;
  }

  const httpsMatch = repoUrl.match(/^https?:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const [, host, path] = httpsMatch;
    return `https://${host}/${path}`;
  }

  return null;
}

/**
 * Which recaps/<span>.md files this commit actually touched, oldest first. Not just
 * "today" -- a backlog-catchup sweep can span several calendar days in one commit, filed
 * under a range-named file instead of a single date (see the wiki's own AGENTS.md "Recap"
 * section).
 */
async function findTouchedRecapFiles(repo: WikiRepo, sha: string): Promise<string[]> {
  const output = await repo.git.raw(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("recaps/") && line.endsWith(".md"))
    .sort();
}

/**
 * Builds the status message body, truncating only the recap portion so `commitLine` (the
 * "View commit" link) always survives -- naively truncating the whole concatenated body would
 * silently drop that link exactly when a reader needs it most: when the recap itself is too
 * long to show in full.
 */
export function buildStatusContent(recap: string | null, commitLine: string): string {
  if (!recap) return commitLine;

  const separator = "\n\n";
  const budget = Math.max(0, MAX_CONTENT_LENGTH - commitLine.length - separator.length - 1);
  const recapBody = recap.length > budget ? `${recap.slice(0, budget)}…` : recap;
  return `${recapBody}${separator}${commitLine}`;
}

async function buildRecapBody(repo: WikiRepo, commitSha: string): Promise<string | null> {
  const recapFiles = await findTouchedRecapFiles(repo, commitSha).catch(() => []);
  if (recapFiles.length === 0) return null;

  const sections = await Promise.all(
    recapFiles.map(async (relativePath) => {
      const content = await readFile(join(repo.dir, relativePath), "utf8").catch(() => null);
      if (!content) return null;
      // One file: just its content. Multiple (a backfill sweep spanning days): label each.
      return recapFiles.length === 1 ? content.trim() : `**${relativePath.replace(/^recaps\/|\.md$/g, "")}**\n${content.trim()}`;
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

    const webUrl = deriveWebUrl(config.wikiSync.repoUrl ?? "");
    const commitLine = webUrl
      ? `[View commit](${webUrl}/commit/${opts.commitSha})`
      : `Commit \`${opts.commitSha.slice(0, 7)}\``;

    const content = buildStatusContent(recap ? recap.trim() : null, commitLine);

    await channel.send({
      components: [buildTextDisplayContainer(content)],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    logger.error({ guildId: opts.guildId, channelId, err }, "failed to post status update");
  }
}
