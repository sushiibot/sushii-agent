import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type Client } from "discord.js";
import { config } from "../../config.ts";
import { getLogger } from "../../logger.ts";
import type { WikiRepo } from "../../modules/wiki-sync/git.ts";
import type { FetchedAttachment, WikiSyncContext } from "../../modules/wiki-sync/context.ts";
import { buildRecapBody, buildStatusContent, deriveWebUrl } from "../../modules/wiki-sync/notify.ts";

const logger = getLogger("surfaces/discord/wiki-sync");

/** Posts the post-sweep status to the guild's configured channel + opens a per-sweep feedback
 *  thread. The Discord SyncNotifier impl; ports the old notify.ts postSyncStatus verbatim. Never
 *  throws — a failed notification must not fail the sweep. */
async function postSyncStatus(client: Client, guildId: string, repo: WikiRepo, commitSha: string): Promise<void> {
  const channelId = config.guildConfig[guildId]?.wiki?.statusChannelId;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) {
      logger.error({ guildId, channelId }, "wikiSyncStatusChannelId is not a guild text channel");
      return;
    }

    const webUrl = deriveWebUrl(config.wikiSync.repoUrl ?? "");
    const recap = await buildRecapBody(repo, commitSha, webUrl);
    const commitLine = webUrl ? `[View commit](${webUrl}/commit/${commitSha})` : `Commit \`${commitSha.slice(0, 7)}\``;
    const content = buildStatusContent(recap ? recap.trim() : null, commitLine);

    const sent = await channel.send({
      components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder({ content }))],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });

    // A thread scoped to this sweep for discussing its output — the next sweep reads it back as
    // feedback (sweep.ts/prompt.ts). Non-fatal: a missing thread just means no feedback surface here.
    try {
      const date = new Date().toISOString().slice(0, 10);
      await sent.startThread({ name: `${date} discuss this sync` });
    } catch (err) {
      logger.warn({ guildId, channelId, err }, "failed to open feedback thread on status message");
    }
  } catch (err) {
    logger.error({ guildId, channelId, err }, "failed to post status update");
  }
}

/** The Discord-backed capability bag for a wiki-sync sweep of one guild (C12). */
export function createDiscordWikiSyncContext(client: Client, guildId: string): WikiSyncContext {
  return {
    channelNames: {
      resolve(channelId) {
        const channel = client.channels.cache.get(channelId);
        return channel && "name" in channel && typeof channel.name === "string" ? channel.name : null;
      },
    },
    attachments: {
      async fetchMessageAttachments(channelId, messageId) {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return [];
        const fresh = await channel.messages.fetch(messageId);
        // Only `message.attachments`, not Components V2 media — wiki-sync only sweeps human messages.
        return [...fresh.attachments.values()].map(
          (a): FetchedAttachment => ({ id: a.id, name: a.name, url: a.url, contentType: a.contentType, size: a.size }),
        );
      },
    },
    notify: {
      postStatus: ({ repo, commitSha }) => postSyncStatus(client, guildId, repo, commitSha),
    },
  };
}
