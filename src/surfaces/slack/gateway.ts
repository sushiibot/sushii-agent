import type { App } from "@slack/bolt";
import { trace } from "@opentelemetry/api";
import type { AgentCore, AuthorRef, ConversationRef, FsHost, InboundAttachment, InboundMessage } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import { SlackSurfaceSession, segmentsToText, type SlackPostClient } from "./session.ts";
import { SlackToolProgress, type SlackProgressRegistry } from "./progress.ts";

const logger = getLogger("surfaces/slack/gateway");
const tracer = trace.getTracer("sushii-agent");

// Shown to the user when a turn fails or produces nothing — a failure is never silent (the ack
// reaction alone would leave them unsure the bot saw them). The trace id lets us correlate in Grafana.
const GENERIC_ERROR = "Sorry — something went wrong handling that.";
const EMPTY_REPLY = "I wasn't able to come up with a response to that.";

const SURFACE = "slack" as const;
// Reacted onto a trigger the moment it's picked up, as a "seen / working on it" signal.
const SEEN_EMOJI = "sushi";

/** Read methods the agent loop uses on top of the write client (parent-message lookup for threaded
 *  replies). `app.client` structurally satisfies both; the cast lives at the wiring boundary. */
export interface SlackAgentClient extends SlackPostClient {
  conversations: {
    replies(args: { channel: string; ts: string; limit?: number }): Promise<{
      messages?: { user?: string; text?: string; bot_id?: string }[];
    }>;
  };
}

export interface SlackAgentDeps {
  core: AgentCore;
  client: SlackAgentClient;
  /** Bot user id from auth.test — the loop-guard identity + session selfId. */
  selfId: string;
  selfName: string;
  /** Workspace team id from auth.test — the memory/server-context scope (analogous to a guild). */
  teamId: string;
  /** Live tool-progress registry. Omitted → no progress display; the turn still runs and errors are
   *  still reported. */
  progress?: SlackProgressRegistry;
  /** This workspace's wiki as an `fs` root (read/search/list). Omitted → the agent has no wiki tools. */
  fsHost?: FsHost;
}

// Loose views of the Bolt event payloads — the union is broad and only a few fields are read.
interface SlackFile {
  id?: string;
  mimetype?: string;
  url_private?: string;
  [k: string]: unknown;
}
interface SlackTriggerEvent {
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  files?: SlackFile[];
  [k: string]: unknown;
}

/** Strip every occurrence of the bot's own mention (with any trailing space) and trim, so the core
 *  sees the message the way a person wrote it minus the summon. Handles both `<@U…>` and the older
 *  labeled `<@U…|name>` form some clients still emit. */
function stripBotMention(text: string, selfId: string): string {
  return text.replace(new RegExp(`<@${selfId}(?:\\|[^>]+)?>\\s*`, "g"), "").trim();
}

/** Map Slack files to neutral attachments. url_private needs a Bearer token to fetch, so image
 *  inspection can't yet resolve them — a known Phase 2 limitation until an auth'd fetch is wired. */
function mapAttachments(files: SlackFile[] | undefined, channel: string, messageTs: string): InboundAttachment[] | undefined {
  if (!files?.length) return undefined;
  return files
    .filter((f) => f.url_private)
    .map((f) => ({
      kind: f.mimetype?.startsWith("image/") ? "image" as const : "file" as const,
      url: f.url_private!,
      contentType: f.mimetype ?? null,
      source: { conversationId: channel, messageId: messageTs },
    }));
}

/** Starts the Slack agent loop on the shared Bolt app: app_mention in channels, every message in a
 *  DM. Coexists with Phase 1 ingestion (registered separately on the same app). */
export function startSlackAgentLoop(app: App, deps: SlackAgentDeps): void {
  const { core, client, selfId, selfName, teamId } = deps;
  const nameCache = new Map<string, string>();

  const resolveName = async (userId: string): Promise<string> => {
    const cached = nameCache.get(userId);
    if (cached) return cached;
    try {
      const res = await client.users.info({ user: userId });
      const u = res.user;
      const name = u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name || userId;
      nameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.warn({ err, userId }, "slack users.info failed");
      return userId;
    }
  };

  const fetchReplyTo = async (channel: string, threadTs: string): Promise<{ author: AuthorRef; text: string } | null> => {
    try {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
      const parent = res.messages?.[0];
      if (!parent?.user || !parent.text) return null;
      return {
        author: { surface: SURFACE, userId: parent.user, username: await resolveName(parent.user) },
        text: parent.text,
      };
    } catch (err) {
      logger.debug({ err, channel, threadTs }, "slack parent-message lookup failed");
      return null;
    }
  };

  const handleTrigger = async (event: SlackTriggerEvent, isPrivate: boolean): Promise<void> => {
    const channel = event.channel;
    const ts = event.ts;
    const user = event.user;
    if (!channel || !ts || !user) return;

    const threadTs = event.thread_ts ?? ts;
    // React "seen" onto the trigger (best-effort — a failed ack must never block the turn).
    try {
      await client.reactions.add({ channel, timestamp: ts, name: SEEN_EMOJI });
    } catch (err) {
      logger.warn({ err, ts }, "slack seen-reaction failed");
    }

    const displayName = await resolveName(user);
    const conversation: ConversationRef = { surface: SURFACE, spaceId: teamId, conversationId: threadTs, isPrivate };
    const rawText = event.text ?? "";
    const text = isPrivate ? rawText.trim() : stripBotMention(rawText, selfId);
    const replyTo = event.thread_ts && event.thread_ts !== ts ? await fetchReplyTo(channel, event.thread_ts) : null;
    const session = new SlackSurfaceSession({ client, selfId, selfName, channelId: channel, threadTs, fsHost: deps.fsHost });
    const inbound: InboundMessage = {
      conversation,
      author: { surface: SURFACE, userId: user, username: displayName, displayName },
      text,
      replyTo,
      attachments: mapAttachments(event.files, channel, ts),
      platform: { surface: SURFACE },
    };

    await tracer.startActiveSpan("slack.message", { attributes: { "slack.channel": channel, "slack.team": teamId } }, async (span) => {
      const tracker = new SlackToolProgress(client, channel, threadTs);
      deps.progress?.track(conversation, tracker);
      let errorText: string | undefined;
      try {
        const res = await core.handleInbound(inbound, session);
        if (res.status === "error") {
          logger.error({ ts, message: res.message }, "slack turn errored");
          errorText = `${GENERIC_ERROR}\n(trace: ${span.spanContext().traceId})`;
        } else if (res.status === "completed" && !segmentsToText(res.reply.segments).trim()) {
          // Mirror session.deliver's own drop condition, so we report exactly the replies it swallows.
          errorText = EMPTY_REPLY;
        }
      } catch (err) {
        logger.error({ err, ts }, "slack turn threw");
        errorText = `${GENERIC_ERROR}\n(trace: ${span.spanContext().traceId})`;
      } finally {
        await tracker.finalize(errorText).catch(() => {});
        deps.progress?.untrack(conversation);
        span.end();
      }
    });
  };

  // Channel mentions. app_mention fires only when the bot is @-mentioned; ingestion's `message`
  // listener still archives every channel message regardless.
  app.event("app_mention", async ({ event }) => {
    const e = event as unknown as SlackTriggerEvent;
    if (e.bot_id || e.user === selfId) return; // never answer ourselves
    await handleTrigger(e, false).catch((err) => logger.error({ err }, "slack app_mention handler failed"));
  });

  // DMs: respond to every message in an `im` channel. A channel mention ALSO arrives here as a
  // `message` event, but is left to app_mention — this handler acts only on `im`, so no double reply.
  // ignoreSelf is off (ingestion archives our own messages), so the bot's own DM replies land here too;
  // dropping bot_id / self / subtyped events is what stops an infinite self-reply loop.
  app.event("message", async ({ event }) => {
    const e = event as unknown as SlackTriggerEvent;
    if (e.channel_type !== "im") return;
    if (e.bot_id || e.user === selfId || e.subtype) return;
    await handleTrigger(e, true).catch((err) => logger.error({ err }, "slack DM handler failed"));
  });
}
