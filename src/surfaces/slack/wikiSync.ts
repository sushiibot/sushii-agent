import type { Database } from "bun:sqlite";
import { config } from "../../config.ts";
import { getDb } from "../../db/index.ts";
import { getLogger } from "../../logger.ts";
import type { WikiSyncMessage } from "../../db/wikiSync.ts";
import type { Replacement, WikiSyncContext } from "../../modules/wiki-sync/context.ts";
import type { WikiSource } from "../../modules/wiki-sync/sources.ts";
import type { WikiRepo } from "../../modules/wiki-sync/git.ts";
import { buildRecapBody, buildStatusContent, deriveWebUrl } from "../../modules/wiki-sync/notify.ts";
import type { SlackPostClient } from "./session.ts";

const logger = getLogger("surfaces/slack/wiki-sync");

const REPLY_SNIPPET_LENGTH = 120;

// System messages that aren't community content. `bot_id IS NULL` already drops bot_message; it's
// kept here as belt-and-braces. NOT IN with a NULL left operand is NULL (falsy), so the sibling
// `subtype IS NULL` branch is what keeps ordinary (unsubtyped) messages in.
const SYSTEM_SUBTYPES = [
  "channel_join",
  "channel_leave",
  "group_join",
  "group_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "bot_message",
];

/** The Slack read/write surface wiki-sync needs: `users.info` + `chat.postMessage` (from the shared
 *  post client) plus `conversations.info` for channel-name resolution. `app.client` structurally
 *  satisfies this; the cast lives at the wiring boundary. */
export interface SlackWikiSyncClient extends Pick<SlackPostClient, "chat" | "users"> {
  conversations: {
    info(args: { channel: string }): Promise<{ channel?: { name?: string } }>;
  };
}

interface SlackMessageQueryRow {
  channel: string;
  ts: string;
  thread_ts: string | null;
  user: string | null;
  text: string | null;
  created_at: number;
}

interface ResolvedAuthor {
  username: string;
  displayName: string | null;
}

function snippet(content: string): string {
  return content.length > REPLY_SNIPPET_LENGTH ? `${content.slice(0, REPLY_SNIPPET_LENGTH)}…` : content;
}

/** Posts the post-sweep status to the source's configured Slack channel. The Slack SyncNotifier impl;
 *  reuses the discord.js-free content builders. Never throws — a failed notification must not fail
 *  the sweep. No feedback thread: Slack thread replies live in the same channel, so a dedicated
 *  status channel already routes as feedback in sweep.ts without one. */
async function postSyncStatus(
  client: SlackWikiSyncClient,
  channelId: string | undefined,
  repo: WikiRepo,
  commitSha: string,
): Promise<void> {
  if (!channelId) return;

  try {
    const webUrl = deriveWebUrl(config.wikiSync.repoUrl ?? "");
    const recap = await buildRecapBody(repo, commitSha, webUrl);
    const commitLine = webUrl ? `<${webUrl}/commit/${commitSha}|View commit>` : `Commit \`${commitSha.slice(0, 7)}\``;
    const content = buildStatusContent(recap ? recap.trim() : null, commitLine);
    await client.chat.postMessage({ channel: channelId, text: content });
  } catch (err) {
    logger.error({ channelId, err }, "failed to post status update");
  }
}

/** Surface-switch for a wiki's sources: builds the Slack port bag for a `(slack, …)` source, null
 *  otherwise. `db` is injectable for tests; production passes the shared connection. */
export function makeSlackWikiSyncContext(
  client: SlackWikiSyncClient,
  workspaceUrl: string,
  _wikiId: string,
  source: WikiSource,
  db: Database = getDb(),
): WikiSyncContext | null {
  if (source.surface !== "slack") return null;
  return createSlackWikiSyncContext(client, workspaceUrl, source, db);
}

/** The Slack-backed capability bag for a wiki-sync sweep of one source (a Slack workspace). */
export function createSlackWikiSyncContext(
  client: SlackWikiSyncClient,
  workspaceUrl: string,
  source: WikiSource,
  db: Database = getDb(),
): WikiSyncContext {
  // Per-context caches so one batch never refetches the same user/channel; a failed lookup caches its
  // null so a miss isn't retried per message.
  const userCache = new Map<string, ResolvedAuthor>();
  const channelCache = new Map<string, string | null>();

  const resolveUser = async (id: string | null): Promise<ResolvedAuthor> => {
    if (!id) return { username: "unknown", displayName: null };
    const cached = userCache.get(id);
    if (cached) return cached;
    let resolved: ResolvedAuthor;
    try {
      const res = await client.users.info({ user: id });
      const u = res.user;
      resolved = {
        username: u?.name ?? id,
        displayName: u?.profile?.display_name || u?.real_name || u?.profile?.real_name || null,
      };
    } catch (err) {
      logger.warn({ err, userId: id }, "slack users.info failed");
      resolved = { username: id, displayName: null };
    }
    userCache.set(id, resolved);
    return resolved;
  };

  const ensureChannelName = async (id: string): Promise<void> => {
    if (channelCache.has(id)) return;
    try {
      const res = await client.conversations.info({ channel: id });
      channelCache.set(id, res.channel?.name ?? null);
    } catch (err) {
      logger.debug({ err, channelId: id }, "slack conversations.info failed");
      channelCache.set(id, null);
    }
  };

  const buildReplyTo = async (
    channel: string,
    threadTs: string | null,
    ts: string,
  ): Promise<WikiSyncMessage["replyTo"]> => {
    if (!threadTs || threadTs === ts) return null;
    const root = db
      .query("SELECT user, text FROM slack_messages WHERE channel = ? AND ts = ?")
      .get(channel, threadTs) as { user: string | null; text: string | null } | undefined;
    if (!root?.text) return null;
    const author = await resolveUser(root.user);
    return { author: author.displayName ?? author.username, content: snippet(root.text) };
  };

  const subtypePlaceholders = SYSTEM_SUBTYPES.map(() => "?").join(", ");
  const query = `SELECT channel, ts, thread_ts, user, text, created_at
     FROM slack_messages
     WHERE team = ? AND created_at > ? AND created_at <= ? AND deleted_at IS NULL AND bot_id IS NULL
       AND (subtype IS NULL OR subtype NOT IN (${subtypePlaceholders}))
     ORDER BY created_at ASC
     LIMIT ?`;

  return {
    messages: {
      async fetchUnprocessed(spaceId, since, until, limit) {
        const rows = db.query(query).all(spaceId, since, until, ...SYSTEM_SUBTYPES, limit) as SlackMessageQueryRow[];

        await Promise.all([...new Set(rows.map((r) => r.channel))].map(ensureChannelName));

        const out: WikiSyncMessage[] = [];
        for (const r of rows) {
          const author = await resolveUser(r.user);
          out.push({
            surface: "slack",
            spaceId,
            messageId: r.ts,
            channelId: r.channel,
            // Slack threads are `thread_ts` within one channel, not a distinct parent channel.
            parentChannelId: null,
            authorId: r.user ?? "",
            authorUsername: author.username,
            authorDisplayName: author.displayName,
            content: r.text ?? "",
            createdAt: r.created_at,
            replyTo: await buildReplyTo(r.channel, r.thread_ts, r.ts),
          });
        }
        return out;
      },
    },
    channelNames: {
      resolve(channelId) {
        return channelCache.get(channelId) ?? null;
      },
    },
    attachments: {
      // TODO: Slack `url_private` needs a Bearer-token fetch to materialize (same gap as the Phase 2
      // inspect_image limitation) — out of scope here.
      async attachmentsFor() {
        return [];
      },
      rewriteAttachmentLinks(content: string, _replacements: Map<string, Replacement>) {
        return content;
      },
    },
    linkFor(message) {
      return `${workspaceUrl}archives/${message.channelId}/p${message.messageId.replaceAll(".", "")}`;
    },
    notify: {
      postStatus: ({ repo, commitSha }) => postSyncStatus(client, source.statusChannelId, repo, commitSha),
    },
  };
}
