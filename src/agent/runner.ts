import type { ToolModelMessage } from "ai";
import type { Client, Message } from "discord.js";
import { searchMessages } from "../tools/searchMessages.ts";
import { getConversationContext } from "../tools/getConversationContext.ts";
import { getUserProfile } from "../tools/getUserProfile.ts";
import { getRecentActivity } from "../tools/getRecentActivity.ts";
import { getCurrentMemberInfo } from "../tools/getCurrentMemberInfo.ts";
import { searchAuditLog } from "../tools/searchAuditLog.ts";
import { resolveUsersByName } from "../tools/resolveUsersByName.ts";
import { fetchChannelMessages } from "../tools/fetchChannelMessages.ts";
import { listGuildChannels, type ChannelInfo } from "../tools/listGuildChannels.ts";
import { getChannelInfo, type ChannelDetail } from "../tools/getChannelInfo.ts";
import { listGuildRoles, type RoleInfo } from "../tools/listGuildRoles.ts";
import { readMemoryTool } from "../tools/readMemory.ts";
import { writeMemoryTool } from "../tools/writeMemory.ts";
import { deleteMemoryTool } from "../tools/deleteMemory.ts";
import { updateServerContextTool } from "../tools/updateServerContext.ts";
import { searchGuildMessages, type SearchGuildMessagesResult } from "../tools/searchGuildMessages.ts";
import { getGuildInfo, type GuildInfo } from "../tools/getGuildInfo.ts";
import { listAutomodRules, type AutomodRuleInfo } from "../tools/listAutomodRules.ts";
import { addAutomodKeyword, type PendingAutomodApproval } from "../tools/addAutomodKeyword.ts";
import { deleteAutomodKeyword, type PendingAutomodDeletion } from "../tools/deleteAutomodKeyword.ts";
import { timeoutMember, type TimeoutMemberResult } from "../tools/timeoutMember.ts";
import { deleteUserMessages, type DeleteUserMessagesResult } from "../tools/deleteUserMessages.ts";
import { sendAlertMessage, type SendAlertMessageResult } from "../tools/sendAlertMessage.ts";
import { webSearch, fetchUrlContent, type WebSearchResultItem, type UrlContentResult } from "../tools/webSearch.ts";
import type { MemoryRow } from "../db/memory.ts";
import type { Logger } from "pino";
import { getLogger } from "../logger.ts";
import { config } from "../config.ts";
import { SushiiMcpClient, type ModCase, type CrossServerBan } from "../mcp/SushiiMcpClient.ts";
import type { AutoModTriggerContext } from "./loop.ts";
import { collectComponentImageUrls } from "../utils/flattenMessage.ts";

const logger = getLogger("tool");

export const mcpClient =
  config.sushiiMcpUrl && config.sushiiMcpToken
    ? new SushiiMcpClient(config.sushiiMcpUrl, config.sushiiMcpToken)
    : null;

export interface UserNames {
  username: string | null;
  displayName: string | null;
}

type MessageRowLike = {
  discord_id: string;
  channel_id: string;
  author_id: string;
  author_username: string | null;
  author_display_name: string | null;
  content: string;
  reply_to_id: string | null;
  created_at: number;
  deleted_at?: number | null;
  is_automod?: number;
  reply_to_content?: string | null;
  reply_to_author_id?: string | null;
};

function formatMessageRow(row: MessageRowLike): string {
  const seconds = Math.floor(row.created_at / 1000);
  let line = `msg:${row.channel_id}/${row.discord_id} t:${seconds}:R u:${row.author_id}: ${row.content}`;
  if (row.reply_to_id) {
    if (row.reply_to_content != null && row.reply_to_author_id != null) {
      line += `\n  [replying to u:${row.reply_to_author_id}: ${row.reply_to_content}]`;
    } else {
      line += `\n  [replying to: msg:${row.channel_id}/${row.reply_to_id}]`;
    }
  }
  if (row.deleted_at) line += " [DELETED]";
  if (row.is_automod) line += " [AUTOMOD]";
  return line;
}

// Derive result types from tool return types so they stay in sync automatically.
type AuditLogEntry = Awaited<ReturnType<typeof searchAuditLog>>[number];
type MemberInfo = Awaited<ReturnType<typeof getCurrentMemberInfo>>;
type UserProfile = ReturnType<typeof getUserProfile>;
type UserCandidate = ReturnType<typeof resolveUsersByName>[number];
type MemoryData = { ok: true } | MemoryRow | MemoryRow[];

type ToolResult =
  | { tool: "error"; message: string }
  | { tool: "ask_question"; question: string; choices: string[] }
  | { tool: "inspect_image"; imageUrls: string[]; deadUrls: string[] }
  | { tool: "search_messages"; data: MessageRowLike[] }
  | { tool: "search_guild_messages"; data: SearchGuildMessagesResult }
  | { tool: "get_conversation_context"; data: MessageRowLike[] }
  | { tool: "get_recent_activity"; data: MessageRowLike[] }
  | { tool: "fetch_channel_messages"; data: MessageRowLike[] }
  | { tool: "get_user_profile"; data: UserProfile }
  | { tool: "get_current_member_info"; data: MemberInfo }
  | { tool: "search_audit_log"; data: AuditLogEntry[] }
  | { tool: "resolve_users_by_name"; data: UserCandidate[] }
  | { tool: "list_guild_roles"; data: RoleInfo[] }
  | { tool: "update_server_context"; data: { ok: boolean } }
  | { tool: "get_channel_info"; data: ChannelDetail | ChannelInfo[] }
  | { tool: "memory"; data: MemoryData }
  | { tool: "get_guild_info"; data: GuildInfo }
  | { tool: "list_automod_rules"; data: AutomodRuleInfo[] }
  | { tool: "pending_automod_keyword_add"; data: PendingAutomodApproval }
  | { tool: "pending_automod_keyword_delete"; data: PendingAutomodDeletion }
  | { tool: "get_user_mod_history"; data: ModCase[] }
  | { tool: "get_user_cross_server_bans"; data: CrossServerBan[] }
  | { tool: "get_guild_recent_cases"; data: ModCase[] }
  | { tool: "timeout_member"; data: TimeoutMemberResult }
  | { tool: "delete_user_messages"; data: DeleteUserMessagesResult }
  | { tool: "send_alert_message"; data: SendAlertMessageResult }
  | { tool: "web_search"; data: WebSearchResultItem[] }
  | { tool: "fetch_url_content"; data: UrlContentResult };

function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "error" in v;
}

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Restricts model-supplied image URLs to Discord's own CDN to prevent using inspect_image as an arbitrary-URL fetch/exfiltration primitive. */
function isDiscordCdnUrl(url: string): boolean {
  try {
    return DISCORD_CDN_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const IMAGE_FETCH_TIMEOUT_MS = 10_000;
const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

type MessageSource = { channel_id: string; message_id: string };
type ImageCandidate = { url: string; source?: MessageSource };

/**
 * Bypasses the discord.js message cache — a cached message carries the signed CDN URL from whenever
 * it was cached, which is the usual reason an attachment URL is already expired by the time it is used.
 */
async function fetchMessageFresh(client: Client, guildId: string, { channel_id, message_id }: MessageSource) {
  const channel = await client.channels.fetch(channel_id);
  if (!channel || !channel.isTextBased()) throw new Error(`Channel ${channel_id} is not a text channel`);
  if (channel.isDMBased() || channel.guildId !== guildId) throw new Error(`Channel ${channel_id} does not belong to this guild`);
  try {
    return await channel.messages.fetch({ message: message_id, force: true });
  } catch (err) {
    throw new Error(`Failed to fetch message ${channel_id}/${message_id}: ${err}`);
  }
}

function messageImageUrls(msg: Message): string[] {
  const attachmentUrls = [...msg.attachments.values()]
    .filter((a) => a.contentType && IMAGE_CONTENT_TYPES.some((t) => a.contentType!.startsWith(t)))
    .map((a) => a.url);
  return [...attachmentUrls, ...collectComponentImageUrls(msg.components as Parameters<typeof collectComponentImageUrls>[0])];
}

/**
 * Only Discord's own CDN is verified: component media items may reference arbitrary external URLs,
 * and fetching those from here would turn inspect_image into an SSRF primitive. Those pass through
 * unverified to the provider, which is where they were always downloaded from anyway.
 */
async function isUsableImageUrl(url: string): Promise<boolean> {
  if (!isDiscordCdnUrl(url)) return true;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** The signature query params change on every refresh, but the path identifies the attachment. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Verifies each URL is actually downloadable, and heals the ones that aren't by re-fetching their
 * source message for a freshly signed URL. Without this a stale or model-mistyped URL reaches the
 * provider, whose download failure aborts the entire agent run.
 */
async function resolveImageCandidates(
  candidates: ImageCandidate[],
  client: Client,
  guildId: string,
): Promise<{ live: string[]; dead: string[] }> {
  // The model often passes the same attachment via both image_urls and messages; without this it
  // gets fetched twice and shown the image twice.
  const unique = new Map<string, ImageCandidate>();
  for (const c of candidates) {
    const existing = unique.get(c.url);
    if (!existing || (!existing.source && c.source)) unique.set(c.url, c);
  }

  const checked = await Promise.all([...unique.values()].map(async (c) => ({ ...c, ok: await isUsableImageUrl(c.url) })));
  const live = checked.filter((c) => c.ok).map((c) => c.url);
  const stale = checked.filter((c) => !c.ok);
  if (stale.length === 0) return { live, dead: [] };

  const dead: string[] = [];
  const bySource = new Map<string, { source: MessageSource; urls: string[] }>();
  for (const c of stale) {
    if (!c.source) {
      dead.push(c.url);
      continue;
    }
    const key = `${c.source.channel_id}/${c.source.message_id}`;
    const group = bySource.get(key) ?? { source: c.source, urls: [] };
    group.urls.push(c.url);
    bySource.set(key, group);
  }

  for (const { source, urls } of bySource.values()) {
    let refreshed: Map<string, string>;
    try {
      const msg = await fetchMessageFresh(client, guildId, source);
      refreshed = new Map(messageImageUrls(msg).map((u) => [urlPath(u), u]));
    } catch {
      dead.push(...urls);
      continue;
    }
    for (const url of urls) {
      const fresh = refreshed.get(urlPath(url));
      if (fresh && fresh !== url && (await isUsableImageUrl(fresh))) live.push(fresh);
      else dead.push(url);
    }
  }

  return { live: [...new Set(live)], dead };
}

function extractUsers(result: ToolResult): Map<string, UserNames> {
  const users = new Map<string, UserNames>();

  let rows: MessageRowLike[] = [];
  switch (result.tool) {
    case "search_messages":
    case "get_conversation_context":
    case "get_recent_activity":
    case "fetch_channel_messages":
      rows = result.data;
      break;
    case "search_guild_messages":
      rows = result.data.messages;
      break;
    case "search_audit_log":
      for (const entry of result.data) {
        if (entry.executorId && !users.has(entry.executorId)) {
          users.set(entry.executorId, { username: entry.executorUsername ?? null, displayName: null });
        }
      }
      return users;
    default:
      return users;
  }

  for (const row of rows) {
    if (!users.has(row.author_id)) {
      users.set(row.author_id, { username: row.author_username ?? null, displayName: row.author_display_name ?? null });
    }
  }

  return users;
}

type ToolInput = Record<string, unknown>;

function describeMessageQuery(tool: string, input: ToolInput): string {
  switch (tool) {
    case "search_messages": {
      const filters: string[] = [];
      if (input.query) filters.push(`query "${input.query as string}"`);
      if (input.user_ids) filters.push(`users [${(input.user_ids as string[]).join(", ")}]`);
      if (input.channel_id) filters.push(`c:${input.channel_id as string}`);
      if (input.since) filters.push(`since t:${Math.floor(Number(input.since) / 1000)}:R`);
      if (input.until) filters.push(`until t:${Math.floor(Number(input.until) / 1000)}:R`);
      return filters.length > 0 ? filters.join(", ") : "an unfiltered browse of recent messages";
    }
    case "get_conversation_context":
      return `context around msg:${input.message_id as string}`;
    case "get_recent_activity":
      return `u:${input.user_id as string}'s recent activity`;
    case "fetch_channel_messages":
      return `c:${input.channel_id as string}`;
    default:
      return "the given filters";
  }
}

function describeGuildMessageQuery(input: ToolInput): string {
  const filters: string[] = [];
  if (input.content) filters.push(`content "${input.content as string}"`);
  if (input.author_id) filters.push(`u:${input.author_id as string}`);
  if (input.channel_id) filters.push(`c:${input.channel_id as string}`);
  if (input.has) filters.push(`has:${input.has as string}`);
  return filters.length > 0 ? filters.join(", ") : "the given filters";
}

function describeAuditLogQuery(input: ToolInput): string {
  const filters: string[] = [];
  if (input.action_type) filters.push(`action:${input.action_type as string}`);
  if (input.executor_id) filters.push(`executor u:${input.executor_id as string}`);
  if (input.target_id) filters.push(`target u:${input.target_id as string}`);
  return filters.length > 0 ? filters.join(", ") : "the given filters";
}

function formatModCaseLine(c: ModCase): string {
  const parts = [`case:${c.caseId} [${c.action}] subject: u:${c.userId} (${c.userTag}) t:${c.actionTime}`];
  if (c.executorId) {
    parts.push(`  executor: u:${c.executorId}`);
  }
  if (c.reason) {
    parts.push(`  reason: ${c.reason}`);
  }
  return parts.join("\n");
}

function formatToolResult(result: ToolResult, input: Record<string, unknown>, log: Logger): string {
  switch (result.tool) {
    case "error":
      return result.message;

    case "search_messages":
    case "get_conversation_context":
    case "get_recent_activity":
    case "fetch_channel_messages": {
      if (result.data.length === 0) return `(no results for ${describeMessageQuery(result.tool, input)} — nothing matches these filters; only different filters will change this, not a different limit)`;
      return result.data.map(formatMessageRow).join("\n");
    }

    case "search_guild_messages": {
      if (result.data.messages.length === 0) {
        return `(no results for ${describeGuildMessageQuery(input)} — nothing matches these filters; only different filters will change this, not a different limit or offset)`;
      }
      return (
        `total: ${result.data.total_results}, showing ${result.data.messages.length}\n` +
        result.data.messages.map(formatMessageRow).join("\n")
      );
    }

    case "search_audit_log": {
      if (result.data.length === 0) return `(no results for ${describeAuditLogQuery(input)} — nothing matches these filters; only different filters will change this, not a different limit)`;
      return result.data
        .map((e) => {
          const seconds = Math.floor(e.createdAt / 1000);
          const executor = e.executorId ? `u:${e.executorId}` : "unknown";
          const target = e.targetId ? `u:${e.targetId}` : "unknown";
          let line = `t:${seconds}:R ${e.action} — ${executor} → ${target}`;
          if (e.reason) line += ` | reason: "${e.reason}"`;
          if (e.changes.length > 0) {
            const changeStrs = e.changes
              .map((c) => `${c.key}: ${JSON.stringify(c.old)}→${JSON.stringify(c.new)}`)
              .join(", ");
            line += `\n  changes: ${changeStrs}`;
          }
          return line;
        })
        .join("\n");
    }

    case "resolve_users_by_name": {
      if (result.data.length === 0) return "(no results)";
      return result.data
        .map((u) => {
          const seconds = Math.floor(u.last_active / 1000);
          const name =
            u.author_display_name && u.author_display_name !== u.author_username
              ? `${u.author_username} / ${u.author_display_name}`
              : (u.author_username ?? "unknown");
          return `u:${u.author_id} ${name} — last active t:${seconds}:R, ${u.message_count} messages`;
        })
        .join("\n");
    }

    case "get_user_profile": {
      const r = result.data;
      const userId = input.user_id as string | undefined;
      const header = userId ? `Profile for u:${userId}:` : "Profile:";

      if (!r.summary || r.summary.total_messages === 0) {
        return `${header}\n(no messages found for this user in the cache)`;
      }

      const lines: string[] = [header];
      if (r.summary.first_seen) lines.push(`first seen: t:${Math.floor(r.summary.first_seen / 1000)}:R`);
      if (r.summary.last_seen) lines.push(`last seen: t:${Math.floor(r.summary.last_seen / 1000)}:R`);
      lines.push(`total messages: ${r.summary.total_messages} across ${r.summary.channel_count} channels`);

      if (r.channelDistribution.length > 0) {
        lines.push("top channels:");
        for (const ch of r.channelDistribution) lines.push(`  c:${ch.channel_id}: ${ch.count} messages`);
      }

      if (r.dailyActivity.length > 0) {
        lines.push("daily activity (recent 30 days):");
        for (const d of r.dailyActivity) lines.push(`  ${d.day}: ${d.count}`);
      }

      return lines.join("\n");
    }

    case "get_current_member_info": {
      const r = result.data;
      if (!r.isStillInServer) return `u:${r.userId} — not in server`;

      const lines: string[] = [];
      lines.push(`user: ${r.username} (u:${r.userId})`);
      if (r.displayName && r.displayName !== r.username) lines.push(`display name: ${r.displayName}`);
      if (r.joinedAt) lines.push(`joined: t:${Math.floor(r.joinedAt / 1000)}:R`);
      lines.push("in server: yes");
      if (r.roles && r.roles.length > 0) {
        lines.push(`roles: ${r.roles.map((role) => `${role.name} (${role.id})`).join(", ")}`);
      } else {
        lines.push("roles: none");
      }
      if (r.avatarUrl) lines.push(`avatarUrl: ${r.avatarUrl}`);
      return lines.join("\n");
    }

    case "get_channel_info": {
      // Single channel
      if (!Array.isArray(result.data)) {
        const r = result.data;
        const lines: string[] = [];
        lines.push(`c:${r.id} #${r.name}`);
        lines.push(`type: ${r.type}`);
        lines.push(`privacy: ${r.isPrivate ? "private (not visible to @everyone)" : "public"}`);
        if (r.categoryName) lines.push(`category: ${r.categoryName}`);
        if (r.parentChannelName) lines.push(`parent channel: #${r.parentChannelName} (c:${r.parentChannelId})`);
        if (r.topic) lines.push(`topic: ${r.topic}`);
        return lines.join("\n");
      }

      // Channel list
      const channels = result.data;
      if (channels.length === 0) return "(no results)";

      const byCategory = new Map<string, { name: string; channels: ChannelInfo[] }>();
      const noCat: ChannelInfo[] = [];

      for (const ch of channels) {
        if (ch.categoryName && ch.categoryId) {
          if (!byCategory.has(ch.categoryId)) byCategory.set(ch.categoryId, { name: ch.categoryName, channels: [] });
          byCategory.get(ch.categoryId)!.channels.push(ch);
        } else {
          noCat.push(ch);
        }
      }

      const lines: string[] = [];
      for (const { name, channels: cats } of byCategory.values()) {
        lines.push(`[${name}]`);
        for (const ch of cats) {
          let line = `  c:${ch.id} #${ch.name} (${ch.type}, ${ch.isPrivate ? "private" : "public"})`;
          if (ch.topic) line += ` — ${ch.topic}`;
          lines.push(line);
        }
      }
      if (noCat.length > 0) {
        lines.push("[No category]");
        for (const ch of noCat) {
          let line = `  c:${ch.id} #${ch.name} (${ch.type}, ${ch.isPrivate ? "private" : "public"})`;
          if (ch.topic) line += ` — ${ch.topic}`;
          lines.push(line);
        }
      }
      return lines.join("\n");
    }

    case "list_guild_roles": {
      if (result.data.length === 0) return "(no results)";
      return result.data
        .map((r) => {
          const flags: string[] = [];
          if (r.isAdmin) flags.push("admin");
          else if (r.isModerator) flags.push("moderator permissions");
          const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
          const colorStr = r.color ? ` ${r.color}` : "";
          return `${r.name} (${r.id})${colorStr}${flagStr}`;
        })
        .join("\n");
    }

    case "memory": {
      const d = result.data;
      if ("ok" in d) return "ok";
      if (Array.isArray(d)) {
        if (d.length === 0) return "(no memories)";
        return d.map((m) => `**${m.title}** (updated t:${Math.floor(m.updated_at / 1000)}:R)\n${m.content}`).join("\n\n---\n\n");
      }
      return `**${d.title}** (updated t:${Math.floor(d.updated_at / 1000)}:R)\n${d.content}`;
    }

    case "get_guild_info": {
      const r = result.data;
      const lines: string[] = [];
      lines.push(`${r.name} (${r.id})`);
      lines.push(`owner: u:${r.ownerId}`);
      lines.push(`created: t:${Math.floor(r.createdAt / 1000)}:R`);
      lines.push(`members: ${r.memberCount.toLocaleString()}`);
      lines.push(`verification: ${r.verificationLevel}`);
      lines.push(`boost tier: ${r.boostTier} (${r.boostCount} boosts)`);
      lines.push(`locale: ${r.preferredLocale}`);
      if (r.description) lines.push(`description: ${r.description}`);
      if (r.features.length > 0) lines.push(`features: ${r.features.join(", ")}`);
      return lines.join("\n");
    }

    case "update_server_context":
      return "ok";

    case "list_automod_rules": {
      if (result.data.length === 0) return "(no automod rules configured)";
      return result.data
        .map((rule) => {
          const status = rule.enabled ? "enabled" : "disabled";
          const lines: string[] = [`rule: "${rule.name}" (id:${rule.id}) [${rule.triggerType}] ${status}`];

          if (rule.keywordFilter.length > 0) {
            const preview = rule.keywordFilter.slice(0, 20).join(", ");
            const more = rule.keywordFilter.length > 20 ? ` [+${rule.keywordFilter.length - 20} more]` : "";
            lines.push(`  keywords (${rule.keywordFilter.length}): ${preview}${more}`);
          }
          if (rule.regexPatterns.length > 0) {
            lines.push(`  regex: ${rule.regexPatterns.length} pattern(s)`);
          }
          if (rule.allowList.length > 0) {
            lines.push(`  allow list: ${rule.allowList.length} item(s)`);
          }

          const actionStrs = rule.actions.map((a) => {
            if (a.type === "send_alert_message" && a.channelId) return `alert → c:${a.channelId}`;
            if (a.type === "timeout" && a.durationSeconds) return `timeout ${a.durationSeconds}s`;
            return a.type;
          });
          if (actionStrs.length > 0) lines.push(`  actions: ${actionStrs.join(", ")}`);

          if (rule.exemptRoleIds.length > 0) lines.push(`  exempt roles: ${rule.exemptRoleIds.map((id) => `r:${id}`).join(", ")}`);
          if (rule.exemptChannelIds.length > 0) lines.push(`  exempt channels: ${rule.exemptChannelIds.map((id) => `c:${id}`).join(", ")}`);

          return lines.join("\n");
        })
        .join("\n\n");
    }

    case "get_user_mod_history": {
      const userId = input.user_id as string;
      const cases = result.data;
      if (cases.length === 0) {
        return `Mod history for u:${userId}: (no cases found — this user has no recorded cases)`;
      }
      return [`Mod history for u:${userId}:`, ...cases.map(formatModCaseLine)].join("\n");
    }

    case "get_guild_recent_cases": {
      const cases = result.data;
      if (cases.length === 0) {
        return "(no recent cases found for this guild)";
      }
      return [
        "Guild's most recent cases — general server activity, not evidence about the user under investigation. Follow one up only if it connects to them (e.g. a linked alt account); otherwise don't pivot to these users:",
        ...cases.map(formatModCaseLine),
      ].join("\n");
    }

    case "get_user_cross_server_bans": {
      const bans = result.data;
      const userId = input.user_id as string;
      if (bans.length === 0) {
        return `Cross-server bans for u:${userId}: (none found)`;
      }
      const lines = bans.map((b) => {
        const name = b.lookupDetailsOptIn ? (b.guildName ?? "unknown") : "[redacted]";
        const parts = [`  guild:${b.guildId} ${name} (${b.guildMembers} members) optIn:${b.lookupDetailsOptIn}`];
        if (b.actionTime) {
          parts.push(`    banned: t:${b.actionTime}`);
        }
        if (b.reason) {
          parts.push(`    reason: ${b.reason}`);
        }
        return parts.join("\n");
      });
      return [`Cross-server bans for u:${userId}:`, ...lines].join("\n");
    }

    case "timeout_member": {
      const r = result.data;
      const mins = Math.round(r.durationMs / 60000);
      const expires = Math.floor(r.expiresAt / 1000);
      const verb = r.dryRun ? "[DRY RUN] Would apply timeout" : "Timeout applied";
      return `${verb}: u:${r.userId} muted for ${mins} minute(s) (expires t:${expires}:R)`;
    }

    case "delete_user_messages": {
      const r = result.data;
      const total = r.bulkDeleted + r.sequentialDeleted;
      const verb = r.dryRun ? "[DRY RUN] Would delete" : "Deleted";
      const header = `${verb} ${total} message(s) (${r.bulkDeleted} bulk, ${r.sequentialDeleted} sequential, ${r.errors} error(s)) of ${r.requested} found`;
      if (r.deleted.length === 0) return header;
      const lines = r.deleted.map((m) => `  msg:${m.id}: "${m.content}"`);
      return `${header}\n${lines.join("\n")}`;
    }

    case "send_alert_message":
      return `Alert sent (msg:${result.data.messageId})`;

    case "web_search": {
      if (result.data.length === 0) return "(no results)";
      return result.data
        .map((r) => {
          const lines: string[] = [`${r.title ?? "(untitled)"} — ${r.url}`];
          if (r.publishedDate) lines.push(`  published: ${r.publishedDate}`);
          for (const h of r.highlights) lines.push(`  "${h}"`);
          return lines.join("\n");
        })
        .join("\n\n");
    }

    case "fetch_url_content": {
      const r = result.data;
      const lines: string[] = [`${r.title ?? "(untitled)"} — ${r.url}`];
      if (r.publishedDate) lines.push(`published: ${r.publishedDate}`);
      lines.push("", r.text || "(no text content)");
      if (r.truncated) lines.push("", "[content truncated — page may contain more]");
      return lines.join("\n");
    }

    // ask_question, inspect_image, and pending approvals are handled before formatToolResult is called
    case "ask_question":
    case "inspect_image":
    case "pending_automod_keyword_add":
    case "pending_automod_keyword_delete":
      log.warn({ tool: result.tool }, "formatToolResult called for tool that should have been handled earlier");
      return "";
  }
}

/**
 * If `pending` is set and other tool results are present, override the specified
 * tool's result with an error and return true (meaning: the pending state was cleared).
 */
function enforceCalledAlone(
  pending: unknown,
  toolCallId: string | undefined,
  toolName: string,
  toolResultParts: ToolModelMessage["content"],
): boolean {
  if (!pending || toolResultParts.length <= 1 || toolCallId === undefined) return false;
  const idx = toolResultParts.findIndex(
    (p) => p.type === "tool-result" && p.toolCallId === toolCallId,
  );
  if (idx === -1) return false;
  toolResultParts[idx] = {
    type: "tool-result",
    toolCallId,
    toolName,
    output: {
      type: "text",
      value: `${toolName} must be called alone — do not combine it with other tool calls in the same turn. Try again with only ${toolName}.`,
    },
  };
  return true;
}

function coerceNumericFields(input: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out = { ...input };
  for (const field of fields) {
    if (field in out) {
      const n = Number(out[field]);
      out[field] = isNaN(n) ? undefined : n;
    }
  }
  return out;
}

type AiToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };

export interface PendingQuestion {
  question: string;
  choices: string[];
}

export interface RunToolsResult {
  toolMessage: ToolModelMessage;
  discoveredUsers: Map<string, UserNames>;
  pendingImages: string[];
  pendingQuestion?: PendingQuestion;
  pendingAutomodApproval?: PendingAutomodApproval;
  pendingAutomodDeletion?: PendingAutomodDeletion;
}

export type { PendingAutomodApproval, PendingAutomodDeletion };

export async function runTools(
  toolCalls: AiToolCall[],
  guildId: string,
  client: Client<true>,
  autoModTrigger?: AutoModTriggerContext,
  log: Logger = logger,
): Promise<RunToolsResult> {
  const executeSingleTool = async (call: AiToolCall): Promise<{ call: AiToolCall; result: ToolResult }> => {
    let result: ToolResult;

    try {
      const input = call.input;
      log.debug({ tool: call.toolName, input }, "tool call");

      switch (call.toolName) {
        case "search_messages": {
          const raw = searchMessages({
            ...coerceNumericFields(input, ["limit", "since", "until"]),
            guildId,
          } as Parameters<typeof searchMessages>[0]);
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "search_messages", data: raw };
          break;
        }
        case "get_conversation_context": {
          const raw = getConversationContext({
            ...coerceNumericFields(input, ["window"]),
            guildId,
          } as Parameters<typeof getConversationContext>[0]);
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "get_conversation_context", data: raw };
          break;
        }
        case "get_user_profile":
          result = { tool: "get_user_profile", data: getUserProfile({ ...input, guildId } as Parameters<typeof getUserProfile>[0]) };
          break;
        case "get_recent_activity":
          result = {
            tool: "get_recent_activity",
            data: getRecentActivity({
              ...coerceNumericFields(input, ["days", "limit"]),
              guildId,
            } as Parameters<typeof getRecentActivity>[0]),
          };
          break;
        case "resolve_users_by_name":
          result = {
            tool: "resolve_users_by_name",
            data: resolveUsersByName({
              ...coerceNumericFields(input, ["days", "limit"]),
              guildId,
            } as Parameters<typeof resolveUsersByName>[0]),
          };
          break;
        case "search_audit_log":
          result = {
            tool: "search_audit_log",
            data: await searchAuditLog({
              ...coerceNumericFields(input, ["limit"]),
              guildId,
              client,
            } as Parameters<typeof searchAuditLog>[0]),
          };
          break;
        case "fetch_channel_messages": {
          const raw = await fetchChannelMessages({
            ...coerceNumericFields(input, ["limit"]),
            guildId,
            client,
          } as Parameters<typeof fetchChannelMessages>[0]);
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "fetch_channel_messages", data: raw };
          break;
        }
        case "search_guild_messages": {
          const raw = await searchGuildMessages({
            ...coerceNumericFields(input, ["limit", "offset"]),
            guildId,
            client,
          } as Parameters<typeof searchGuildMessages>[0]);
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "search_guild_messages", data: raw };
          break;
        }
        case "inspect_image": {
          const { image_urls, messages } = input as {
            image_urls?: string[];
            messages?: { channel_id: string; message_id: string }[];
          };
          if ((!image_urls || image_urls.length === 0) && (!messages || messages.length === 0)) {
            result = { tool: "error", message: "inspect_image requires image_urls, messages, or both." };
            break;
          }

          const candidates: ImageCandidate[] = [];
          if (image_urls && image_urls.length > 0) {
            const invalid = image_urls.filter((u) => !isDiscordCdnUrl(u));
            if (invalid.length > 0) {
              result = { tool: "error", message: `image_urls must be discordapp.com or discordapp.net CDN URLs. Rejected: ${invalid.join(", ")}` };
              break;
            }
            candidates.push(...image_urls.map((url) => ({ url })));
          }

          if (messages && messages.length > 0) {
            let messagesError: ToolResult | null = null;
            for (const source of messages) {
              try {
                const msg = await fetchMessageFresh(client, guildId, source);
                candidates.push(...messageImageUrls(msg).map((url) => ({ url, source })));
              } catch (err) {
                messagesError = { tool: "error", message: err instanceof Error ? err.message : String(err) };
                break;
              }
            }
            if (messagesError) {
              result = messagesError;
              break;
            }
          }

          const { live, dead } = await resolveImageCandidates(candidates, client, guildId);
          result = { tool: "inspect_image", imageUrls: live, deadUrls: dead };
          break;
        }
        case "get_current_member_info":
          result = {
            tool: "get_current_member_info",
            data: await getCurrentMemberInfo({ ...input, guildId, client } as Parameters<typeof getCurrentMemberInfo>[0]),
          };
          break;
        case "get_channel_info": {
          const raw = input.channel_id
            ? await getChannelInfo({ ...input, guildId, client } as Parameters<typeof getChannelInfo>[0])
            : await listGuildChannels({ guildId, client });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "get_channel_info", data: raw };
          break;
        }
        case "list_guild_roles": {
          const raw = await listGuildRoles({ guildId, client });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "list_guild_roles", data: raw };
          break;
        }
        case "update_server_context": {
          const raw = updateServerContextTool({ ...input, guildId } as Parameters<typeof updateServerContextTool>[0]);
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "update_server_context", data: raw };
          break;
        }
        case "memory": {
          const action = input.action as string;
          const raw =
            action === "write"
              ? writeMemoryTool({ ...input, guildId } as Parameters<typeof writeMemoryTool>[0])
              : action === "delete"
                ? deleteMemoryTool({ ...input, guildId } as Parameters<typeof deleteMemoryTool>[0])
                : readMemoryTool({ ...input, guildId } as Parameters<typeof readMemoryTool>[0]);
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "memory", data: raw as MemoryData };
          break;
        }
        case "get_guild_info": {
          const raw = await getGuildInfo({ guildId, client });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "get_guild_info", data: raw };
          break;
        }
        case "list_automod_rules": {
          const raw = await listAutomodRules({ guildId, client });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "list_automod_rules", data: raw };
          break;
        }
        case "add_automod_keyword": {
          const raw = await addAutomodKeyword({
            guildId,
            ruleId: input.rule_id as string,
            keyword: input.keyword as string,
            client,
          });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "pending_automod_keyword_add", data: raw };
          break;
        }
        case "delete_automod_keyword": {
          const raw = await deleteAutomodKeyword({
            guildId,
            ruleId: input.rule_id as string,
            keyword: input.keyword as string,
            client,
          });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "pending_automod_keyword_delete", data: raw };
          break;
        }
        case "timeout_member": {
          const gc = config.guildConfig[guildId];
          if (!gc) { result = { tool: "error", message: "Guild not configured" }; break; }
          const immuneIds = [...new Set([...(gc.modImmuneRoleIds ?? []), ...gc.allowedRoles])];
          const raw = await timeoutMember({
            user_id: input.user_id as string,
            duration_ms: input.duration_ms as number,
            reason: input.reason as string | undefined,
            guildId,
            client,
            modImmuneRoleIds: immuneIds,
            dryRun: gc.autoModDryRun,
          });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "timeout_member", data: raw };
          break;
        }
        case "delete_user_messages": {
          const gc = config.guildConfig[guildId];
          const raw = await deleteUserMessages({
            user_id: input.user_id as string,
            channel_id: input.channel_id as string,
            limit: input.limit as number | undefined,
            guildId,
            client,
            dryRun: gc?.autoModDryRun,
          });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "delete_user_messages", data: raw };
          break;
        }
        case "send_alert_message": {
          const gc = config.guildConfig[guildId];
          if (!gc?.alertsChannelId || !gc.modRoleId) {
            result = { tool: "error", message: "alertsChannelId or modRoleId not configured for this guild" };
            break;
          }
          const raw = await sendAlertMessage({
            findings: input.findings as string,
            action: input.action as string,
            guildId,
            client,
            alertsChannelId: gc.alertsChannelId,
            modRoleId: gc.modRoleId,
            dryRun: gc.autoModDryRun,
            anchorMessageId: autoModTrigger?.anchorMessageId,
            incidentChannelId: autoModTrigger?.incidentChannelId,
            triggerMessageId: autoModTrigger?.triggerMessageId,
          });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "send_alert_message", data: raw };
          break;
        }
        case "ask_question":
          result = { tool: "ask_question", question: input.question as string, choices: input.choices as string[] };
          break;
        case "get_user_mod_history": {
          if (!mcpClient) {
            result = { tool: "error", message: "sushii-mcp not configured" };
            break;
          }
          try {
            const data = await mcpClient.getUserModHistory({
              guild_id: guildId,
              user_id: input.user_id as string,
              limit: input.limit as number | undefined,
              before_case_id: input.before_case_id as string | undefined,
            });
            result = { tool: "get_user_mod_history", data };
          } catch (err) {
            result = { tool: "error", message: String(err) };
          }
          break;
        }
        case "get_user_cross_server_bans": {
          if (!mcpClient) {
            result = { tool: "error", message: "sushii-mcp not configured" };
            break;
          }
          try {
            const data = await mcpClient.getUserCrossServerBans({
              user_id: input.user_id as string,
            });
            result = { tool: "get_user_cross_server_bans", data };
          } catch (err) {
            result = { tool: "error", message: String(err) };
          }
          break;
        }
        case "get_guild_recent_cases": {
          if (!mcpClient) {
            result = { tool: "error", message: "sushii-mcp not configured" };
            break;
          }
          try {
            const data = await mcpClient.getGuildRecentCases({
              guild_id: guildId,
              limit: input.limit as number | undefined,
            });
            result = { tool: "get_guild_recent_cases", data };
          } catch (err) {
            result = { tool: "error", message: String(err) };
          }
          break;
        }
        case "web_search": {
          const raw = await webSearch({
            ...coerceNumericFields(input, ["num_results"]),
            query: input.query as string,
            search_type: input.search_type as Parameters<typeof webSearch>[0]["search_type"],
          });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "web_search", data: raw };
          break;
        }
        case "fetch_url_content": {
          const raw = await fetchUrlContent({ url: input.url as string });
          result = isError(raw) ? { tool: "error", message: raw.error } : { tool: "fetch_url_content", data: raw };
          break;
        }
        default:
          result = { tool: "error", message: `Unknown tool: ${call.toolName}` };
      }
    } catch (err) {
      log.error({ err, tool: call.toolName }, "tool error");
      result = { tool: "error", message: String(err) };
    }

    return { call, result };
  };

  // timeout_member must land before delete_user_messages — otherwise the offending
  // user can keep posting new messages while deletion is still in flight.
  const timeoutCalls = toolCalls.filter((c) => c.toolName === "timeout_member");
  const otherCalls = toolCalls.filter((c) => c.toolName !== "timeout_member");

  const timeoutResults = await Promise.all(timeoutCalls.map(executeSingleTool));
  const otherResults = await Promise.all(otherCalls.map(executeSingleTool));

  const resultByCallId = new Map(
    [...timeoutResults, ...otherResults].map((r) => [r.call.toolCallId, r] as const),
  );
  const rawResults = toolCalls.map((c) => resultByCallId.get(c.toolCallId)!);

  const discoveredUsers = new Map<string, UserNames>();
  const toolResultParts: ToolModelMessage["content"] = [];
  const pendingImages: string[] = [];
  let pendingQuestion: PendingQuestion | undefined;
  let askQuestionToolCallId: string | undefined;
  let pendingAutomodApproval: PendingAutomodApproval | undefined;
  let automodApprovalToolCallId: string | undefined;
  let pendingAutomodDeletion: PendingAutomodDeletion | undefined;
  let automodDeletionToolCallId: string | undefined;

  for (const { call, result } of rawResults) {
    if (result.tool === "ask_question") {
      pendingQuestion = { question: result.question, choices: result.choices };
      askQuestionToolCallId = call.toolCallId;
      toolResultParts.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: "Question sent to moderator. Awaiting their response via button click." },
      });
      continue;
    }

    if (result.tool === "pending_automod_keyword_add") {
      pendingAutomodApproval = result.data;
      automodApprovalToolCallId = call.toolCallId;
      toolResultParts.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: `Keyword addition queued for moderator approval. The moderator will see a confirmation prompt showing the change to rule "${result.data.ruleName}".` },
      });
      continue;
    }

    if (result.tool === "pending_automod_keyword_delete") {
      pendingAutomodDeletion = result.data;
      automodDeletionToolCallId = call.toolCallId;
      toolResultParts.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: `Keyword deletion queued for moderator approval. The moderator will see a confirmation prompt showing the removal from rule "${result.data.ruleName}".` },
      });
      continue;
    }

    if (result.tool === "inspect_image") {
      const lines: string[] = [];
      if (result.imageUrls.length > 0) {
        pendingImages.push(...result.imageUrls);
        lines.push(
          `${result.imageUrls.length} image(s) attached directly below this tool result — read them from there. They are already in front of you; do not call inspect_image again for them.`,
        );
      }
      if (result.deadUrls.length > 0) {
        lines.push(
          `${result.deadUrls.length} image URL(s) could not be loaded — the signature is expired or the URL is mistyped, and refreshing it failed. Do not retype or guess these URLs. Call inspect_image again with the channel_id + message_id they came from via \`messages\`, which re-fetches live:\n${result.deadUrls.map((u) => `- ${u}`).join("\n")}`,
        );
      }
      if (lines.length === 0) {
        lines.push("No image attachments found on that message.");
      }
      toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: lines.join("\n\n") } });
      continue;
    }

    for (const [id, names] of extractUsers(result)) {
      if (!discoveredUsers.has(id)) discoveredUsers.set(id, names);
    }

    const content = formatToolResult(result, call.input, log);
    log.debug({ tool: call.toolName, resultLength: content.length }, "tool result");

    toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: content } });
  }

  // If ask_question or add_automod_keyword was called alongside other tools, override it with
  // an error so the loop continues normally — these tools must be called alone.
  if (enforceCalledAlone(pendingQuestion, askQuestionToolCallId, "ask_question", toolResultParts)) {
    pendingQuestion = undefined;
  }
  if (enforceCalledAlone(pendingAutomodApproval, automodApprovalToolCallId, "add_automod_keyword", toolResultParts)) {
    pendingAutomodApproval = undefined;
  }
  if (enforceCalledAlone(pendingAutomodDeletion, automodDeletionToolCallId, "delete_automod_keyword", toolResultParts)) {
    pendingAutomodDeletion = undefined;
  }

  return { toolMessage: { role: "tool", content: toolResultParts }, discoveredUsers, pendingImages, pendingQuestion, pendingAutomodApproval, pendingAutomodDeletion };
}
