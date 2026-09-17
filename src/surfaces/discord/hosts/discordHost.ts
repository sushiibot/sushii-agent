// Concrete DiscordToolHost — wraps a discord.js Client. Ports src/tools/{addAutomodKeyword,
// automodUtils,channelUtils,deleteAutomodKeyword,fetchChannelMessages,getChannelInfo,
// getCurrentMemberInfo,getGuildInfo,listAutomodRules,listGuildChannels,listGuildRoles,
// searchAuditLog,searchGuildMessages,sendAlertMessage,timeoutMember}.ts. The deletion half of
// deleteUserMessages.ts lives here (candidate selection lives in DiscordMessageCacheHost); see
// that file's comment for the live-API-fallback split.
import { makeURLSearchParams } from "@discordjs/rest";
import {
  AuditLogEvent,
  ChannelType,
  ContainerBuilder,
  GuildVerificationLevel,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import { AutoModerationActionType, AutoModerationRuleTriggerType } from "discord-api-types/v10";
import type { GuildConfig } from "../../../guildConfig.ts";
import { collectComponentImageUrls } from "../../../utils/flattenMessage.ts";
import { renderDiscordText } from "../render.ts";
import "../../../core/tools/hosts.ts";
import type {
  AutomodActionInfo,
  DiscordAuditLogEntry,
  DiscordAutomodRuleInfo,
  DiscordChannelDetail,
  DiscordChannelInfo,
  DiscordDeleteMessagesResult,
  DiscordGuildInfo,
  DiscordMemberInfo,
  DiscordMessageResult,
  DiscordModerationConfig,
  DiscordPendingAutomodEdit,
  DiscordRoleInfo,
  DiscordSendAlertResult,
  DiscordTimeoutResult,
} from "../../../core/tools/hosts.ts";

const SUPPORTED_AUTOMOD_TRIGGER_TYPES = [
  AutoModerationRuleTriggerType.Keyword,
  AutoModerationRuleTriggerType.MemberProfile,
];

function channelTypeName(type: ChannelType): string {
  switch (type) {
    case ChannelType.GuildText: return "text";
    case ChannelType.GuildVoice: return "voice";
    case ChannelType.GuildAnnouncement: return "announcement";
    case ChannelType.GuildForum: return "forum";
    case ChannelType.GuildStageVoice: return "stage";
    case ChannelType.PublicThread: return "thread (public)";
    case ChannelType.PrivateThread: return "thread (private)";
    default: return "other";
  }
}

function isPrivateChannel(
  channel: { type: ChannelType; permissionOverwrites?: { cache: Map<string, { deny: { has: (flag: bigint) => boolean } }> } },
  everyoneRoleId: string,
): boolean {
  if (channel.type === ChannelType.PrivateThread) return true;
  const overwrite = channel.permissionOverwrites?.cache?.get(everyoneRoleId);
  return overwrite?.deny?.has(PermissionFlagsBits.ViewChannel) ?? false;
}

function verificationLevelName(level: GuildVerificationLevel): string {
  switch (level) {
    case GuildVerificationLevel.None: return "none";
    case GuildVerificationLevel.Low: return "low (verified email)";
    case GuildVerificationLevel.Medium: return "medium (registered 5+ min)";
    case GuildVerificationLevel.High: return "high (member 10+ min)";
    case GuildVerificationLevel.VeryHigh: return "very high (verified phone)";
    default: return "unknown";
  }
}

const NOTABLE_GUILD_FEATURES = new Set([
  "COMMUNITY", "DISCOVERABLE", "PARTNERED", "VERIFIED", "NEWS", "ANIMATED_ICON", "BANNER",
  "INVITE_SPLASH", "WELCOME_SCREEN_ENABLED", "MEMBER_VERIFICATION_GATE_ENABLED", "PREVIEW_ENABLED",
  "TICKETED_EVENTS_ENABLED", "MONETIZATION_ENABLED", "MORE_STICKERS", "THREADS_ENABLED",
  "PRIVATE_THREADS", "ROLE_ICONS", "AUTO_MODERATION",
]);

function automodActionTypeName(t: number): AutomodActionInfo["type"] {
  switch (t) {
    case AutoModerationActionType.BlockMessage: return "block_message";
    case AutoModerationActionType.SendAlertMessage: return "send_alert_message";
    case AutoModerationActionType.Timeout: return "timeout";
    case AutoModerationActionType.BlockMemberInteraction: return "block_member_interaction";
    default: return "unknown";
  }
}

function automodTriggerTypeName(t: number): string {
  switch (t) {
    case AutoModerationRuleTriggerType.Keyword: return "KEYWORD";
    case AutoModerationRuleTriggerType.Spam: return "SPAM";
    case AutoModerationRuleTriggerType.KeywordPreset: return "KEYWORD_PRESET";
    case AutoModerationRuleTriggerType.MentionSpam: return "MENTION_SPAM";
    case AutoModerationRuleTriggerType.MemberProfile: return "MEMBER_PROFILE";
    default: return `UNKNOWN(${t})`;
  }
}

const AUDIT_ACTION_TYPE_MAP: Record<string, AuditLogEvent> = {
  ban: AuditLogEvent.MemberBanAdd,
  unban: AuditLogEvent.MemberBanRemove,
  kick: AuditLogEvent.MemberKick,
  member_update: AuditLogEvent.MemberUpdate,
  role_update: AuditLogEvent.MemberRoleUpdate,
  message_delete: AuditLogEvent.MessageDelete,
  message_bulk_delete: AuditLogEvent.MessageBulkDelete,
  automod_block: AuditLogEvent.AutoModerationBlockMessage,
};

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REPORTED_MESSAGES = 25;
const MAX_REPORTED_CONTENT = 200;
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const MAX_REASON_LENGTH = 48;
const ALERT_TEXT_DISPLAY_MAX = 4000;

function snowflakeToMs(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

function sanitizeTimeoutReason(reason: string | undefined): string | undefined {
  const collapsed = reason?.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > MAX_REASON_LENGTH
    ? `${collapsed.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

function truncateForAlertDisplay(label: string, body: string): string {
  const content = `${label}\n${body}`;
  if (content.length <= ALERT_TEXT_DISPLAY_MAX) return content;
  const suffix = "\n… (truncated)";
  return content.slice(0, ALERT_TEXT_DISPLAY_MAX - suffix.length) + suffix;
}

export class DiscordHost {
  constructor(
    private readonly client: Client<true>,
    private readonly guildId: string,
    private readonly guildConfig: GuildConfig | undefined,
  ) {}

  private async fetchAutomodRule(ruleId: string): Promise<
    { ruleId: string; ruleName: string; keywordFilter: string[]; regexPatterns: string[]; allowList: string[] } | { error: string }
  > {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      let rule;
      try {
        rule = await guild.autoModerationRules.fetch({ autoModerationRule: ruleId, force: true });
      } catch {
        return { error: `Rule ${ruleId} not found or bot lacks MANAGE_GUILD permission.` };
      }
      if (!SUPPORTED_AUTOMOD_TRIGGER_TYPES.includes(rule.triggerType as AutoModerationRuleTriggerType)) {
        return { error: `Rule "${rule.name}" has trigger type ${rule.triggerType} which does not support keyword_filter. Only KEYWORD and MEMBER_PROFILE rules support this.` };
      }
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        keywordFilter: [...(rule.triggerMetadata.keywordFilter ?? [])],
        regexPatterns: [...(rule.triggerMetadata.regexPatterns ?? [])],
        allowList: [...(rule.triggerMetadata.allowList ?? [])],
      };
    } catch (err) {
      return { error: `Failed to fetch automod rule: ${err}` };
    }
  }

  async fetchChannelMessages(args: {
    channelId: string; messageId?: string; before?: string; after?: string; around?: string; limit?: number;
  }): Promise<DiscordMessageResult[] | { error: string }> {
    let channel;
    try {
      const fetched = await this.client.channels.fetch(args.channelId);
      if (!fetched || !fetched.isTextBased()) return { error: `Channel ${args.channelId} is not a text channel` };
      if (fetched.isDMBased() || fetched.guildId !== this.guildId) return { error: `Channel ${args.channelId} does not belong to this guild` };
      channel = fetched;
    } catch (err) {
      return { error: `Failed to fetch channel: ${err}` };
    }

    const { buildMessageContent } = await import("../../../utils/flattenMessage.ts");
    const toResult = (m: import("discord.js").Message): DiscordMessageResult => {
      let content = buildMessageContent(m);
      if (content === "[empty message]") {
        content = "[no readable content — likely a bot embed or media attachment that cannot be retrieved via API]";
      }
      return {
        discordId: m.id,
        channelId: m.channelId,
        authorId: m.author.id,
        authorUsername: m.author.username,
        authorDisplayName: m.author.displayName !== m.author.username ? m.author.displayName : null,
        content,
        replyToId: m.reference?.messageId ?? null,
        createdAt: m.createdTimestamp,
        editedAt: m.editedTimestamp,
      };
    };

    try {
      if (args.messageId) {
        const msg = await channel.messages.fetch(args.messageId);
        return [toResult(msg)];
      }
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
      const options: { before?: string; after?: string; around?: string; limit: number } = { limit };
      if (args.before) options.before = args.before;
      else if (args.after) options.after = args.after;
      else if (args.around) options.around = args.around;

      const messages = await channel.messages.fetch(options);
      return [...messages.values()].map(toResult).sort((a, b) => a.createdAt - b.createdAt);
    } catch (err) {
      return { error: `Failed to fetch messages: ${err}` };
    }
  }

  async searchGuildMessages(args: {
    content?: string; authorId?: string; channelId?: string; has?: string; limit?: number; offset?: number;
    sortBy?: "timestamp" | "relevance"; sortOrder?: "asc" | "desc";
  }): Promise<{ messages: DiscordMessageResult[]; totalResults: number } | { error: string }> {
    try {
      const query: Record<string, string | number> = {};
      if (args.content) query.content = args.content;
      if (args.authorId) query.author_id = args.authorId;
      if (args.channelId) query.channel_id = args.channelId;
      if (args.has) query.has = args.has;
      if (args.limit) query.limit = Math.min(25, Math.max(1, Math.round(args.limit)));
      if (args.offset) query.offset = args.offset;
      if (args.sortBy) query.sort_by = args.sortBy;
      if (args.sortOrder) query.sort_order = args.sortOrder;

      interface APIMessageAuthor { id: string; username: string; global_name?: string | null }
      interface APIMessage { id: string; channel_id: string; author: APIMessageAuthor; content: string; timestamp: string; referenced_message?: APIMessage | null }
      interface SearchResponse { total_results: number; messages: APIMessage[][]; doing_deep_historical_index?: boolean }

      const data = (await this.client.rest.get(`/guilds/${this.guildId}/messages/search`, {
        query: makeURLSearchParams(query),
      })) as SearchResponse;

      if (data.doing_deep_historical_index) {
        return { error: "Discord is still indexing this server's messages. Try again shortly." };
      }

      const messages: DiscordMessageResult[] = data.messages.map((group) => {
        const msg = group[0];
        const ref = msg.referenced_message ?? null;
        return {
          discordId: msg.id,
          channelId: msg.channel_id,
          authorId: msg.author.id,
          authorUsername: msg.author.username ?? null,
          authorDisplayName: msg.author.global_name ?? null,
          content: msg.content,
          replyToId: ref?.id ?? null,
          createdAt: new Date(msg.timestamp).getTime(),
          editedAt: null,
        };
      });

      return { messages, totalResults: data.total_results };
    } catch (err) {
      return { error: `search_guild_messages failed: ${err}. This endpoint returns at most 25 results per call; use offset to paginate for more.` };
    }
  }

  async listGuildChannels(): Promise<DiscordChannelInfo[] | { error: string }> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      await guild.channels.fetch();
      const everyoneRoleId = guild.roles.everyone.id;

      const byCategory = new Map<string | null, DiscordChannelInfo[]>();
      for (const [, channel] of guild.channels.cache) {
        if (!channel) continue;
        if (channel.type === ChannelType.GuildCategory) continue;
        if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) continue;

        const parentId = "parentId" in channel ? channel.parentId : null;
        if (!byCategory.has(parentId)) byCategory.set(parentId, []);

        const info: DiscordChannelInfo = {
          id: channel.id,
          name: channel.name,
          type: channelTypeName(channel.type),
          isPrivate: isPrivateChannel(channel as Parameters<typeof isPrivateChannel>[0], everyoneRoleId),
        };
        if ("topic" in channel && channel.topic) info.topic = channel.topic;
        byCategory.get(parentId)!.push(info);
      }

      const result: DiscordChannelInfo[] = [];
      const categories = [...guild.channels.cache.values()]
        .filter((c) => c?.type === ChannelType.GuildCategory)
        .sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));

      for (const cat of categories) {
        if (!cat) continue;
        const children = (byCategory.get(cat.id) ?? []).sort((a, b) => {
          const ca = guild.channels.cache.get(a.id);
          const cb = guild.channels.cache.get(b.id);
          return ((ca as { position?: number })?.position ?? 0) - ((cb as { position?: number })?.position ?? 0);
        });
        for (const ch of children) {
          ch.categoryId = cat.id;
          ch.categoryName = cat.name;
          result.push(ch);
        }
      }
      for (const ch of byCategory.get(null) ?? []) result.push(ch);
      return result;
    } catch (err) {
      return { error: `Failed to fetch guild channels: ${err}` };
    }
  }

  async getChannelInfo(channelId: string): Promise<DiscordChannelDetail | { error: string }> {
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      return { error: `Failed to fetch channel ${channelId}: ${err}` };
    }
    if (!channel || channel.isDMBased()) return { error: `Channel ${channelId} not found or not a guild channel` };
    if (channel.guildId !== this.guildId) return { error: `Channel ${channelId} does not belong to this guild` };

    const guild = await this.client.guilds.fetch(this.guildId);
    const everyoneRoleId = guild.roles.everyone.id;
    const isPrivate = isPrivateChannel(channel as Parameters<typeof isPrivateChannel>[0], everyoneRoleId);

    const detail: DiscordChannelDetail = {
      id: channel.id,
      name: "name" in channel ? (channel.name as string) : "(unknown)",
      type: channelTypeName(channel.type),
      isPrivate,
    };
    if ("topic" in channel && channel.topic) detail.topic = channel.topic as string;

    const parentId = "parentId" in channel ? (channel.parentId as string | null) : null;
    if (parentId) {
      const parent = guild.channels.cache.get(parentId) ?? await this.client.channels.fetch(parentId);
      if (parent && "name" in parent) {
        if (parent.type === ChannelType.GuildCategory) {
          detail.categoryId = parentId;
          detail.categoryName = parent.name as string;
        } else {
          detail.parentChannelId = parentId;
          detail.parentChannelName = parent.name as string;
          const grandparentId = "parentId" in parent ? (parent.parentId as string | null) : null;
          if (grandparentId) {
            const grandparent = guild.channels.cache.get(grandparentId);
            if (grandparent && grandparent.type === ChannelType.GuildCategory) {
              detail.categoryId = grandparentId;
              detail.categoryName = grandparent.name;
            }
          }
        }
      }
    }
    return detail;
  }

  async listGuildRoles(): Promise<DiscordRoleInfo[] | { error: string }> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      await guild.roles.fetch();
      return [...guild.roles.cache.values()]
        .filter((r) => r.name !== "@everyone")
        .sort((a, b) => b.position - a.position)
        .map((r) => {
          const perms = r.permissions;
          const info: DiscordRoleInfo = {
            id: r.id,
            name: r.name,
            position: r.position,
            isAdmin: perms.has(PermissionFlagsBits.Administrator),
            isModerator:
              perms.has(PermissionFlagsBits.Administrator) ||
              perms.has(PermissionFlagsBits.BanMembers) ||
              perms.has(PermissionFlagsBits.KickMembers) ||
              perms.has(PermissionFlagsBits.ModerateMembers) ||
              perms.has(PermissionFlagsBits.ManageMessages),
          };
          const hex = r.hexColor;
          if (hex && hex !== "#000000") info.color = hex;
          return info;
        });
    } catch (err) {
      return { error: `Failed to fetch guild roles: ${err}` };
    }
  }

  async getGuildInfo(): Promise<DiscordGuildInfo | { error: string }> {
    try {
      const guild = await this.client.guilds.fetch({ guild: this.guildId, withCounts: true });
      const features = guild.features
        .filter((f) => NOTABLE_GUILD_FEATURES.has(f))
        .map((f) => f.toLowerCase().replace(/_/g, "-"));

      const info: DiscordGuildInfo = {
        id: guild.id,
        name: guild.name,
        ownerId: guild.ownerId,
        createdAt: guild.createdTimestamp,
        memberCount: guild.approximateMemberCount ?? guild.memberCount,
        verificationLevel: verificationLevelName(guild.verificationLevel),
        boostTier: guild.premiumTier,
        boostCount: guild.premiumSubscriptionCount ?? 0,
        preferredLocale: guild.preferredLocale,
        features,
      };
      if (guild.description) info.description = guild.description;
      return info;
    } catch (err) {
      return { error: `Failed to fetch guild info: ${err}` };
    }
  }

  async getCurrentMemberInfo(userId: string): Promise<DiscordMemberInfo> {
    const guild = this.client.guilds.cache.get(this.guildId) ?? await this.client.guilds.fetch(this.guildId);
    try {
      const member = await guild.members.fetch(userId);
      return {
        userId: member.id,
        username: member.user.username,
        displayName: member.displayName,
        joinedAt: member.joinedAt?.getTime() ?? null,
        roles: [...member.roles.cache.values()]
          .filter((r) => r.id !== this.guildId)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name })),
        isStillInServer: true,
        avatarUrl: member.displayAvatarURL({ size: 256 }),
      };
    } catch {
      return { userId, isStillInServer: false };
    }
  }

  async searchAuditLog(args: { actionType?: string; executorId?: string; targetId?: string; limit?: number }): Promise<DiscordAuditLogEntry[]> {
    const guild = this.client.guilds.cache.get(this.guildId) ?? await this.client.guilds.fetch(this.guildId);
    const auditLogs = await guild.fetchAuditLogs({
      limit: 100,
      type: args.actionType ? AUDIT_ACTION_TYPE_MAP[args.actionType] : undefined,
      user: args.executorId ?? undefined,
    });

    let entries = [...auditLogs.entries.values()];
    if (args.targetId) {
      entries = entries.filter((e) => (e.target as { id?: string } | null)?.id === args.targetId);
    }
    const limit = Math.min(args.limit ?? 25, 100);
    entries = entries.slice(0, limit);

    return entries.map((entry) => ({
      createdAt: entry.createdTimestamp,
      action: AuditLogEvent[entry.action] ?? String(entry.action),
      executorId: entry.executor?.id ?? null,
      executorUsername: entry.executor?.username ?? null,
      targetId: (entry.target as { id?: string } | null)?.id ?? null,
      reason: entry.reason ?? null,
      changes: entry.changes?.map((c) => ({ key: c.key, old: c.old, new: c.new })) ?? [],
    }));
  }

  async listAutomodRules(): Promise<DiscordAutomodRuleInfo[] | { error: string }> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const rules = await guild.autoModerationRules.fetch();
      return [...rules.values()].map((rule) => {
        const actions: AutomodActionInfo[] = [...rule.actions.values()].map((action) => {
          const info: AutomodActionInfo = { type: automodActionTypeName(action.type) };
          if (action.metadata.channelId) info.channelId = action.metadata.channelId;
          if (action.metadata.durationSeconds != null) info.durationSeconds = action.metadata.durationSeconds;
          if (action.metadata.customMessage != null) info.customMessage = action.metadata.customMessage;
          return info;
        });
        return {
          id: rule.id,
          name: rule.name,
          triggerType: automodTriggerTypeName(rule.triggerType),
          enabled: rule.enabled,
          keywordFilter: [...(rule.triggerMetadata.keywordFilter ?? [])],
          regexPatterns: [...(rule.triggerMetadata.regexPatterns ?? [])],
          allowList: [...(rule.triggerMetadata.allowList ?? [])],
          actions,
          exemptRoleIds: [...rule.exemptRoles.keys()],
          exemptChannelIds: [...rule.exemptChannels.keys()],
        };
      });
    } catch (err) {
      return { error: `Failed to fetch automod rules: ${err}` };
    }
  }

  async addAutomodKeyword(args: { ruleId: string; keyword: string }): Promise<DiscordPendingAutomodEdit | { error: string }> {
    if (args.keyword.length > 60) return { error: `Keyword "${args.keyword}" exceeds the 60-character Discord limit.` };
    const ruleData = await this.fetchAutomodRule(args.ruleId);
    if ("error" in ruleData) return ruleData;

    const normalizedKeyword = args.keyword.toLowerCase();
    if (ruleData.keywordFilter.some((k) => k.toLowerCase() === normalizedKeyword)) {
      return { error: `Keyword "${args.keyword}" is already in rule "${ruleData.ruleName}". No change made.` };
    }
    if (ruleData.keywordFilter.length >= 1000) {
      return { error: `Rule "${ruleData.ruleName}" already has 1000 keywords, which is the Discord limit. Remove some before adding more.` };
    }

    return {
      ruleId: ruleData.ruleId,
      ruleName: ruleData.ruleName,
      keyword: args.keyword,
      newKeywordFilter: [...ruleData.keywordFilter, args.keyword],
      regexPatterns: ruleData.regexPatterns,
      allowList: ruleData.allowList,
    };
  }

  async deleteAutomodKeyword(args: { ruleId: string; keyword: string }): Promise<DiscordPendingAutomodEdit | { error: string }> {
    const ruleData = await this.fetchAutomodRule(args.ruleId);
    if ("error" in ruleData) return ruleData;

    const normalizedTarget = args.keyword.toLowerCase();
    const existing = ruleData.keywordFilter.find((k) => k.toLowerCase() === normalizedTarget);
    if (!existing) {
      return { error: `Keyword "${args.keyword}" was not found in rule "${ruleData.ruleName}". Use list_automod_rules to see current keywords.` };
    }

    return {
      ruleId: ruleData.ruleId,
      ruleName: ruleData.ruleName,
      keyword: existing,
      newKeywordFilter: ruleData.keywordFilter.filter((k) => k !== existing),
      regexPatterns: ruleData.regexPatterns,
      allowList: ruleData.allowList,
    };
  }

  getModerationConfig(): DiscordModerationConfig | null {
    if (!this.guildConfig) return null;
    return {
      modImmuneRoleIds: [...new Set([...(this.guildConfig.modImmuneRoleIds ?? []), ...this.guildConfig.allowedRoles])],
      alertsChannelId: this.guildConfig.alertsChannelId,
      modRoleId: this.guildConfig.modRoleId,
      autoModDryRun: this.guildConfig.autoModDryRun,
    };
  }

  async timeoutMember(args: {
    userId: string; durationMs: number; reason?: string; modImmuneRoleIds: string[]; dryRun?: boolean;
  }): Promise<DiscordTimeoutResult | { error: string }> {
    const durationMs = Math.min(Math.max(args.durationMs, 1000), MAX_TIMEOUT_MS);

    let guild;
    try {
      guild = this.client.guilds.cache.get(this.guildId) ?? await this.client.guilds.fetch(this.guildId);
    } catch (err) {
      return { error: `Failed to fetch guild: ${err}` };
    }

    let member;
    try {
      member = await guild.members.fetch(args.userId);
    } catch {
      return { error: `User ${args.userId} is not in the server or could not be fetched.` };
    }

    const memberRoleIds = [...member.roles.cache.keys()];
    if (args.modImmuneRoleIds.some((id) => memberRoleIds.includes(id))) {
      return { error: `Cannot timeout u:${args.userId} — they have a mod-immune role. Send alert instead.` };
    }

    if (!args.dryRun) {
      try {
        await member.timeout(durationMs, sanitizeTimeoutReason(args.reason));
      } catch (err) {
        return { error: `Discord API error applying timeout: ${err}` };
      }
    }

    return {
      userId: args.userId,
      durationMs,
      expiresAt: Date.now() + durationMs,
      ...(args.dryRun ? { dryRun: true } : {}),
    };
  }

  /** Deletes the given (already-selected) candidates: bulk-deletes those ≤14 days old, falls back
   *  to sequential deletion for the rest. Candidate selection — including the live-API fallback
   *  when the cache is thin — happens upstream in DiscordMessageCacheHost.findDeletableMessages. */
  async deleteMemberMessages(args: {
    channelId: string; candidates: { id: string; content: string; createdAt: number }[]; dryRun?: boolean;
  }): Promise<DiscordDeleteMessagesResult | { error: string }> {
    let channel: GuildTextBasedChannel;
    try {
      const fetched = await this.client.channels.fetch(args.channelId);
      if (!fetched?.isTextBased() || fetched.isDMBased() || fetched.guildId !== this.guildId) {
        return { error: `Channel ${args.channelId} is invalid or not in this guild.` };
      }
      channel = fetched as GuildTextBasedChannel;
    } catch (err) {
      return { error: `Failed to fetch channel: ${err}` };
    }

    const contentById = new Map(args.candidates.map((c) => [c.id, c.content]));
    const summarize = (id: string): { id: string; content: string } => {
      const raw = contentById.get(id) ?? "";
      const content = raw.length > 0 ? raw.slice(0, MAX_REPORTED_CONTENT) : "(no text content — attachment/embed only)";
      return { id, content };
    };

    const cutoff = Date.now() - FOURTEEN_DAYS_MS;
    const recentIds: string[] = [];
    const oldIds: string[] = [];
    for (const c of args.candidates) {
      if (snowflakeToMs(c.id) >= cutoff) recentIds.push(c.id);
      else oldIds.push(c.id);
    }

    if (args.dryRun) {
      const attempted = [...recentIds, ...oldIds];
      return {
        requested: args.candidates.length,
        bulkDeleted: recentIds.length,
        sequentialDeleted: oldIds.length,
        errors: 0,
        deleted: attempted.slice(0, MAX_REPORTED_MESSAGES).map(summarize),
        dryRun: true,
      };
    }

    let bulkDeleted = 0;
    let sequentialDeleted = 0;
    let errors = 0;
    const deleted: { id: string; content: string }[] = [];

    if (recentIds.length > 0 && "bulkDelete" in channel) {
      try {
        const result = await channel.bulkDelete(recentIds, true);
        bulkDeleted = result.size;
        for (const id of result.keys()) deleted.push(summarize(id));
      } catch {
        for (const id of recentIds) {
          try {
            const msg = await channel.messages.fetch(id).catch(() => null);
            if (msg) {
              await msg.delete();
              sequentialDeleted++;
              deleted.push(summarize(id));
            }
          } catch { errors++; }
        }
      }
    }

    for (const id of oldIds) {
      try {
        const msg = await channel.messages.fetch(id).catch(() => null);
        if (msg) {
          await msg.delete();
          sequentialDeleted++;
          deleted.push(summarize(id));
        }
      } catch { errors++; }
    }

    return {
      requested: args.candidates.length,
      bulkDeleted,
      sequentialDeleted,
      errors,
      deleted: deleted.slice(0, MAX_REPORTED_MESSAGES),
    };
  }

  async sendAlertMessage(args: {
    findings: string; action: string; alertsChannelId: string; modRoleId: string; dryRun?: boolean;
    anchor?: { anchorMessageId?: string; incidentChannelId?: string; triggerMessageId?: string };
  }): Promise<DiscordSendAlertResult | { error: string }> {
    let channel: GuildTextBasedChannel;
    try {
      const fetched = await this.client.channels.fetch(args.alertsChannelId);
      if (!fetched?.isTextBased() || fetched.isDMBased() || fetched.guildId !== this.guildId) {
        return { error: `Alerts channel ${args.alertsChannelId} is invalid or not in this guild.` };
      }
      channel = fetched as GuildTextBasedChannel;
    } catch (err) {
      return { error: `Failed to fetch alerts channel: ${err}` };
    }

    const container = new ContainerBuilder().addTextDisplayComponents(
      new TextDisplayBuilder({ content: `<@&${args.modRoleId}> 🚨 **Auto-mod alert**` }),
    );

    container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
    const triggerLine =
      args.anchor?.incidentChannelId && args.anchor?.triggerMessageId
        ? `Triggered by: https://discord.com/channels/${this.guildId}/${args.anchor.incidentChannelId}/${args.anchor.triggerMessageId}`
        : "(trigger info unavailable)";
    container.addTextDisplayComponents(new TextDisplayBuilder({ content: `**Trigger**\n${triggerLine}` }));

    container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
    container.addTextDisplayComponents(
      new TextDisplayBuilder({ content: truncateForAlertDisplay("**Findings**", renderDiscordText(args.findings, this.guildId)) }),
    );

    container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
    container.addTextDisplayComponents(
      new TextDisplayBuilder({ content: truncateForAlertDisplay("**Action taken**", renderDiscordText(args.action, this.guildId)) }),
    );

    if (args.dryRun) {
      container.addSeparatorComponents(new SeparatorBuilder({ divider: true, spacing: SeparatorSpacingSize.Small }));
      container.addTextDisplayComponents(new TextDisplayBuilder({ content: "🧪 **DRY RUN — no action was actually taken.**" }));
    }

    const payload = {
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
      allowedMentions: { roles: [args.modRoleId] },
    };

    if (args.anchor?.anchorMessageId) {
      try {
        const anchor = await channel.messages.fetch(args.anchor.anchorMessageId);
        const edited = await anchor.edit(payload);
        return { messageId: edited.id };
      } catch {
        // Anchor may have been deleted or is otherwise unreachable — fall through to sending fresh.
      }
    }

    try {
      const sent = await channel.send(payload);
      return { messageId: sent.id };
    } catch (err) {
      return { error: `Failed to send alert: ${err}` };
    }
  }

  async fetchMessageImageUrls(source: { channelId: string; messageId: string }): Promise<string[] | { error: string }> {
    try {
      const channel = await this.client.channels.fetch(source.channelId);
      if (!channel?.isTextBased()) return { error: `Channel ${source.channelId} is not a text channel` };
      const message = await channel.messages.fetch(source.messageId);
      const attachmentUrls = [...message.attachments.values()]
        .filter((a) => a.contentType?.startsWith("image/"))
        .map((a) => a.url);
      const componentUrls = collectComponentImageUrls(message.components as Parameters<typeof collectComponentImageUrls>[0]);
      return [...new Set([...attachmentUrls, ...componentUrls])];
    } catch (err) {
      return { error: `Failed to fetch message: ${err}` };
    }
  }
}
