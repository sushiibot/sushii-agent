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

    const today = new Date().toISOString().slice(0, 10);
    const recap = await readFile(join(opts.repo.dir, "daily", `${today}.md`), "utf8").catch(() => null);

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
