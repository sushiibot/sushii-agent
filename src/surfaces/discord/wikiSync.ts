import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type Client } from "discord.js";
import { config } from "../../config.ts";
import { getDb } from "../../db/index.ts";
import { getLogger } from "../../logger.ts";
import { getUnprocessedMessages, type WikiSyncMessage } from "../../db/wikiSync.ts";
import type { WikiRepo } from "../../modules/wiki-sync/git.ts";
import type { FetchedAttachment, Replacement, WikiSyncContext } from "../../modules/wiki-sync/context.ts";
import type { WikiSource } from "../../modules/wiki-sync/sources.ts";
import { buildRecapBody, buildStatusContent, deriveWebUrl } from "../../modules/wiki-sync/notify.ts";

const logger = getLogger("surfaces/discord/wiki-sync");

// Discord CDN URLs expire, so a stored message's own content can't be trusted for attachment
// links at sweep time — these detect a stored CDN reference and, after a live re-fetch, map each
// materialized attachment back onto its content label by the attachment id embedded in the URL
// (the re-fetched URL is re-signed and won't string-match the stored one).
const CDN_MARKER = "cdn.discordapp.com/attachments/";
const CDN_LABEL_URL_RE = /\]\((https:\/\/cdn\.discordapp\.com\/attachments\/\d+\/(\d+)\/[^\s)]+)\)/g;

/** Posts the post-sweep status to the source's configured channel + opens a per-sweep feedback
 *  thread. The Discord SyncNotifier impl; ports the old notify.ts postSyncStatus verbatim. Never
 *  throws — a failed notification must not fail the sweep. */
async function postSyncStatus(
  client: Client,
  guildId: string,
  channelId: string | undefined,
  repo: WikiRepo,
  commitSha: string,
): Promise<void> {
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

/** Surface-switch for a wiki's sources: builds the Discord port bag for a `(discord, …)` source,
 *  null otherwise (that source's surface isn't wired here — e.g. a future Slack source). */
export function makeDiscordWikiSyncContext(client: Client, _wikiId: string, source: WikiSource): WikiSyncContext | null {
  if (source.surface !== "discord") return null;
  return createDiscordWikiSyncContext(client, source);
}

/** The Discord-backed capability bag for a wiki-sync sweep of one source (a Discord guild). */
export function createDiscordWikiSyncContext(client: Client, source: WikiSource): WikiSyncContext {
  const guildId = source.spaceId;
  return {
    messages: {
      fetchUnprocessed(spaceId, since, until, limit) {
        return getUnprocessedMessages(getDb(), spaceId, since, until, limit);
      },
    },
    channelNames: {
      resolve(channelId) {
        const channel = client.channels.cache.get(channelId);
        return channel && "name" in channel && typeof channel.name === "string" ? channel.name : null;
      },
    },
    attachments: {
      async attachmentsFor(message: WikiSyncMessage) {
        // No CDN reference in the stored content → nothing to materialize, and crucially no live
        // API re-fetch per message.
        if (!message.content.includes(CDN_MARKER)) return [];
        const channel = await client.channels.fetch(message.channelId);
        if (!channel || !channel.isTextBased()) return [];
        const fresh = await channel.messages.fetch(message.messageId);
        // Only `message.attachments`, not Components V2 media — wiki-sync only sweeps human messages.
        return [...fresh.attachments.values()].map(
          (a): FetchedAttachment => ({ id: a.id, name: a.name, url: a.url, contentType: a.contentType, size: a.size }),
        );
      },
      rewriteAttachmentLinks(content: string, replacements: Map<string, Replacement>) {
        return content.replace(CDN_LABEL_URL_RE, (full, _url, attachmentId) => {
          const replacement = replacements.get(attachmentId);
          return replacement ? `](${replacement.url})${replacement.extra ?? ""}` : full;
        });
      },
    },
    linkFor(message) {
      return `https://discord.com/channels/${message.spaceId}/${message.channelId}/${message.messageId}`;
    },
    notify: {
      postStatus: ({ repo, commitSha }) => postSyncStatus(client, guildId, source.statusChannelId, repo, commitSha),
    },
  };
}
