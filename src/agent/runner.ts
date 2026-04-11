import type { ToolModelMessage } from "ai";
import type { Client } from "discord.js";
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
import type { MemoryRow } from "../db/memory.ts";
import { getLogger } from "../logger.ts";

const logger = getLogger("tool");

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
  | { tool: "inspect_image"; imageUrls: string[] }
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
  | { tool: "get_guild_info"; data: GuildInfo };

function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "error" in v;
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

function formatToolResult(result: ToolResult, input: Record<string, unknown>): string {
  switch (result.tool) {
    case "error":
      return result.message;

    case "search_messages":
    case "get_conversation_context":
    case "get_recent_activity":
    case "fetch_channel_messages": {
      if (result.data.length === 0) return "(no results)";
      return result.data.map(formatMessageRow).join("\n");
    }

    case "search_guild_messages": {
      if (result.data.messages.length === 0) return `(no results — total: ${result.data.total_results})`;
      return (
        `total: ${result.data.total_results}, showing ${result.data.messages.length}\n` +
        result.data.messages.map(formatMessageRow).join("\n")
      );
    }

    case "search_audit_log": {
      if (result.data.length === 0) return "(no results)";
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

    // ask_question and inspect_image are handled before formatToolResult is called
    case "ask_question":
    case "inspect_image":
      return "";
  }
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
}

export async function runTools(
  toolCalls: AiToolCall[],
  guildId: string,
  client: Client<true>,
): Promise<RunToolsResult> {
  const rawResults = await Promise.all(
    toolCalls.map(async (call) => {
      let result: ToolResult;

      try {
        const input = call.input;
        logger.debug({ tool: call.toolName, input }, "tool call");

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
            const { channel_id, message_id } = input as { channel_id: string; message_id: string };
            try {
              const channel = await client.channels.fetch(channel_id);
              if (!channel || !channel.isTextBased()) {
                result = { tool: "error", message: `Channel ${channel_id} is not a text channel` };
                break;
              }
              if (channel.isDMBased() || channel.guildId !== guildId) {
                result = { tool: "error", message: `Channel ${channel_id} does not belong to this guild` };
                break;
              }
              const msg = await channel.messages.fetch(message_id);
              const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
              const urls = [...msg.attachments.values()]
                .filter((a) => a.contentType && imageTypes.some((t) => a.contentType!.startsWith(t)))
                .map((a) => a.url);
              result = { tool: "inspect_image", imageUrls: urls };
            } catch (err) {
              result = { tool: "error", message: `Failed to fetch message: ${err}` };
            }
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
          case "ask_question":
            result = { tool: "ask_question", question: input.question as string, choices: input.choices as string[] };
            break;
          default:
            result = { tool: "error", message: `Unknown tool: ${call.toolName}` };
        }
      } catch (err) {
        logger.error({ err, tool: call.toolName }, "tool error");
        result = { tool: "error", message: String(err) };
      }

      return { call, result };
    }),
  );

  const discoveredUsers = new Map<string, UserNames>();
  const toolResultParts: ToolModelMessage["content"] = [];
  const pendingImages: string[] = [];
  let pendingQuestion: PendingQuestion | undefined;
  let askQuestionToolCallId: string | undefined;

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

    if (result.tool === "inspect_image") {
      if (result.imageUrls.length === 0) {
        toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "No image attachments found on that message." } });
      } else {
        pendingImages.push(...result.imageUrls);
        toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: `${result.imageUrls.length} image(s) queued — they will appear in the next message for your analysis.` } });
      }
      continue;
    }

    for (const [id, names] of extractUsers(result)) {
      if (!discoveredUsers.has(id)) discoveredUsers.set(id, names);
    }

    const content = formatToolResult(result, call.input);
    logger.debug({ tool: call.toolName, resultLength: content.length }, "tool result");

    toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: content } });
  }

  // If ask_question was called alongside other tools, override it with an error so the loop
  // continues normally — ask_question must be called alone.
  if (pendingQuestion && toolResultParts.length > 1 && askQuestionToolCallId !== undefined) {
    const idx = toolResultParts.findIndex(
      (p) => p.type === "tool-result" && p.toolCallId === askQuestionToolCallId,
    );
    if (idx !== -1) {
      toolResultParts[idx] = {
        type: "tool-result",
        toolCallId: askQuestionToolCallId,
        toolName: "ask_question",
        output: {
          type: "text",
          value: "ask_question must be called alone — do not combine it with other tool calls in the same turn. Try again with only ask_question.",
        },
      };
    }
    pendingQuestion = undefined;
  }

  return { toolMessage: { role: "tool", content: toolResultParts }, discoveredUsers, pendingImages, pendingQuestion };
}
