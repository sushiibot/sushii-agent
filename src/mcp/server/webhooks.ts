import { DiscordAPIError, RESTJSONErrorCodes, WebhookType } from "discord.js";
import type {
  Client,
  GuildTextBasedChannel,
  TextChannel,
  NewsChannel,
  VoiceChannel,
  StageChannel,
  ForumChannel,
  MediaChannel,
  Webhook,
} from "discord.js";
import type { DiscordIdentity } from "./session.ts";

const WEBHOOK_NAME = "sushii-agent MCP bridge";

type WebhookCapableChannel = TextChannel | NewsChannel | VoiceChannel | StageChannel | ForumChannel | MediaChannel;
type IncomingWebhook = Webhook<WebhookType.Incoming>;

interface WebhookTarget {
  channel: WebhookCapableChannel;
  /** Set when posting into a thread — webhooks live on the parent channel but execute with this threadId. */
  threadId?: string;
}

function hasWebhookMethods(channel: object | null): boolean {
  return !!channel && "fetchWebhooks" in channel && "createWebhook" in channel;
}

/** Threads can't own webhooks directly — resolve to the parent channel plus a threadId to route into. */
function resolveWebhookTarget(channel: GuildTextBasedChannel): WebhookTarget | { error: string } {
  if (channel.isThread()) {
    const parent = channel.parent;
    if (!hasWebhookMethods(parent)) {
      return { error: `Thread ${channel.id}'s parent channel doesn't support webhooks` };
    }
    return { channel: parent as WebhookCapableChannel, threadId: channel.id };
  }
  if (!hasWebhookMethods(channel)) {
    return { error: `Channel ${channel.id} doesn't support webhooks` };
  }
  return { channel: channel as WebhookCapableChannel };
}

/**
 * Per-channel webhook lookup/creation with an in-memory cache. Nothing is persisted —
 * a process restart pays one extra fetch-or-create per channel on first use.
 */
export class WebhookCache {
  private readonly cache = new Map<string, IncomingWebhook>();
  // Dedupes concurrent resolution calls for the same channel — without this, two concurrent
  // first sends to an uncached channel both find nothing and both create a webhook, and
  // Discord caps webhooks at 15/channel.
  private readonly inflight = new Map<string, Promise<IncomingWebhook>>();

  private async resolveFromDiscord(client: Client<true>, channel: WebhookCapableChannel): Promise<IncomingWebhook> {
    const existingInflight = this.inflight.get(channel.id);
    if (existingInflight) return existingInflight;

    const promise = (async () => {
      const webhooks = await channel.fetchWebhooks();
      const existing = webhooks.find(
        (w): w is IncomingWebhook => w.type === WebhookType.Incoming && w.owner?.id === client.user.id,
      );
      if (existing) return existing;
      return channel.createWebhook({ name: WEBHOOK_NAME });
    })();

    this.inflight.set(channel.id, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(channel.id) === promise) this.inflight.delete(channel.id);
    }
  }

  /** Evicts any cached entry for `channel`, re-resolves from Discord, and re-caches the result. */
  private async refresh(client: Client<true>, channel: WebhookCapableChannel): Promise<IncomingWebhook> {
    this.cache.delete(channel.id);
    const webhook = await this.resolveFromDiscord(client, channel);
    this.cache.set(channel.id, webhook);
    return webhook;
  }

  private async cached(client: Client<true>, channel: WebhookCapableChannel): Promise<IncomingWebhook> {
    return this.cache.get(channel.id) ?? this.refresh(client, channel);
  }

  /** Posts `content` under `identity`'s name/avatar, self-healing once if the cached webhook was deleted. */
  async send(
    client: Client<true>,
    channel: GuildTextBasedChannel,
    content: string,
    identity: DiscordIdentity,
  ): Promise<void> {
    const target = resolveWebhookTarget(channel);
    if ("error" in target) throw new Error(target.error);

    const webhook = await this.cached(client, target.channel);
    try {
      await this.execute(webhook, content, identity, target.threadId);
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownWebhook) {
        const fresh = await this.refresh(client, target.channel);
        await this.execute(fresh, content, identity, target.threadId);
        return;
      }
      throw err;
    }
  }

  private async execute(
    webhook: IncomingWebhook,
    content: string,
    identity: DiscordIdentity,
    threadId: string | undefined,
  ): Promise<void> {
    const avatarURL = identity.avatar
      ? `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.png`
      : undefined;
    await webhook.send({
      content,
      username: identity.username,
      avatarURL,
      threadId,
      allowedMentions: { parse: [] },
    });
  }
}
