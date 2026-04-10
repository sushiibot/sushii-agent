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
import { listGuildChannels } from "../tools/listGuildChannels.ts";
import { getChannelInfo } from "../tools/getChannelInfo.ts";
import { listGuildRoles, type RoleInfo } from "../tools/listGuildRoles.ts";
import { readMemoryTool } from "../tools/readMemory.ts";
import { writeMemoryTool } from "../tools/writeMemory.ts";
import { deleteMemoryTool } from "../tools/deleteMemory.ts";
import { updateServerContextTool } from "../tools/updateServerContext.ts";
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

function extractUsersFromResult(result: unknown): Map<string, UserNames> {
  const users = new Map<string, UserNames>();

  if (Array.isArray(result)) {
    for (const row of result) {
      if (!row || typeof row !== "object") continue;

      // Message rows — author name stripped from output, inject via identity mappings instead
      if ("discord_id" in row) {
        const r = row as MessageRowLike;
        if (!users.has(r.author_id)) {
          users.set(r.author_id, { username: r.author_username ?? null, displayName: r.author_display_name ?? null });
        }
      }

      // Audit log entries — executor name is not visible in formatted output
      if ("executorId" in row) {
        const r = row as { executorId: string | null; executorUsername?: string | null };
        if (r.executorId && !users.has(r.executorId)) {
          users.set(r.executorId, { username: r.executorUsername ?? null, displayName: null });
        }
      }
    }
  }

  return users;
}

function formatToolResult(toolName: string, result: unknown, input?: Record<string, unknown>): string {
  // Error objects — applies to all tools
  if (result && typeof result === "object" && !Array.isArray(result) && "error" in result) {
    return (result as { error: string }).error;
  }

  switch (toolName) {
    case "search_audit_log": {
      if (!Array.isArray(result)) return JSON.stringify(result, null, 2);
      if (result.length === 0) return "(no results)";
      return result
        .map(
          (e: {
            action: string;
            executorId: string | null;
            targetId: string | null;
            reason: string | null;
            createdAt: number;
            changes: Array<{ key: string; old: unknown; new: unknown }>;
          }) => {
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
          },
        )
        .join("\n");
    }

    case "search_messages":
    case "get_conversation_context":
    case "get_recent_activity":
    case "fetch_channel_messages": {
      if (!Array.isArray(result)) return JSON.stringify(result, null, 2);
      if (result.length === 0) return "(no results)";
      return result.map((r) => formatMessageRow(r as MessageRowLike)).join("\n");
    }

    case "resolve_users_by_name": {
      if (!Array.isArray(result)) return JSON.stringify(result, null, 2);
      if (result.length === 0) return "(no results)";
      return result
        .map(
          (u: {
            author_id: string;
            author_username: string | null;
            author_display_name: string | null;
            last_active: number;
            message_count: number;
          }) => {
            const seconds = Math.floor(u.last_active / 1000);
            const name =
              u.author_display_name && u.author_display_name !== u.author_username
                ? `${u.author_username} / ${u.author_display_name}`
                : (u.author_username ?? "unknown");
            return `u:${u.author_id} ${name} — last active t:${seconds}:R, ${u.message_count} messages`;
          },
        )
        .join("\n");
    }

    case "get_user_profile": {
      const r = result as {
        summary: {
          first_seen: number | null;
          last_seen: number | null;
          total_messages: number;
          channel_count: number;
        } | null;
        channelDistribution: { channel_id: string; count: number }[];
        dailyActivity: { day: string; count: number }[];
      };

      const userId = input?.user_id as string | undefined;
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
        for (const ch of r.channelDistribution) {
          lines.push(`  c:${ch.channel_id}: ${ch.count} messages`);
        }
      }

      if (r.dailyActivity.length > 0) {
        lines.push("daily activity (recent 30 days):");
        for (const d of r.dailyActivity) {
          lines.push(`  ${d.day}: ${d.count}`);
        }
      }

      return lines.join("\n");
    }

    case "get_current_member_info": {
      const r = result as {
        userId: string;
        isStillInServer: boolean;
        username?: string;
        displayName?: string;
        joinedAt?: number | null;
        roles?: { id: string; name: string }[];
      };

      if (!r.isStillInServer) {
        return `u:${r.userId} — not in server`;
      }

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

    case "list_guild_channels": {
      if (!Array.isArray(result)) return JSON.stringify(result, null, 2);
      if (result.length === 0) return "(no results)";
      type ChannelInfo = {
        id: string;
        name: string;
        type: string;
        isPrivate: boolean;
        topic?: string;
        categoryId?: string;
        categoryName?: string;
        parentChannelId?: string;
        parentChannelName?: string;
      };
      const channels = result as ChannelInfo[];

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
          const privacy = ch.isPrivate ? "private" : "public";
          let line = `  c:${ch.id} #${ch.name} (${ch.type}, ${privacy})`;
          if (ch.topic) line += ` — ${ch.topic}`;
          lines.push(line);
        }
      }
      if (noCat.length > 0) {
        lines.push("[No category]");
        for (const ch of noCat) {
          const privacy = ch.isPrivate ? "private" : "public";
          let line = `  c:${ch.id} #${ch.name} (${ch.type}, ${privacy})`;
          if (ch.topic) line += ` — ${ch.topic}`;
          lines.push(line);
        }
      }

      return lines.join("\n");
    }

    case "list_guild_roles": {
      if (!Array.isArray(result)) return JSON.stringify(result, null, 2);
      if (result.length === 0) return "(no results)";
      return (result as RoleInfo[])
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

    case "read_memory": {
      // Single memory object
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const r = result as { title: string; content: string; updated_at: number };
        return `**${r.title}** (updated t:${Math.floor(r.updated_at / 1000)}:R)\n${r.content}`;
      }
      // Array of memories
      if (Array.isArray(result)) {
        if (result.length === 0) return "(no results)";
        type MemoryRow = { title: string; content: string; updated_at: number };
        return (result as MemoryRow[])
          .map((m) => `**${m.title}** (updated t:${Math.floor(m.updated_at / 1000)}:R)\n${m.content}`)
          .join("\n\n---\n\n");
      }
      return JSON.stringify(result, null, 2);
    }

    case "get_channel_info": {
      const r = result as {
        id: string;
        name: string;
        type: string;
        isPrivate: boolean;
        topic?: string;
        categoryName?: string;
        categoryId?: string;
        parentChannelId?: string;
        parentChannelName?: string;
      };
      const lines: string[] = [];
      lines.push(`c:${r.id} #${r.name}`);
      lines.push(`type: ${r.type}`);
      lines.push(`privacy: ${r.isPrivate ? "private (not visible to @everyone)" : "public"}`);
      if (r.categoryName) lines.push(`category: ${r.categoryName}`);
      if (r.parentChannelName) lines.push(`parent channel: #${r.parentChannelName} (c:${r.parentChannelId})`);
      if (r.topic) lines.push(`topic: ${r.topic}`);
      return lines.join("\n");
    }

    default:
      return JSON.stringify(result, null, 2);
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
      let result: unknown;

      try {
        const input = call.input;
        logger.debug({ tool: call.toolName, input }, "tool call");

        switch (call.toolName) {
          case "search_messages":
            result = searchMessages({
              ...coerceNumericFields(input, ["limit", "since", "until"]),
              guildId,
            } as Parameters<typeof searchMessages>[0]);
            break;
          case "get_conversation_context":
            result = getConversationContext({
              ...coerceNumericFields(input, ["window"]),
              guildId,
            } as Parameters<typeof getConversationContext>[0]);
            break;
          case "get_user_profile":
            result = getUserProfile({ ...input, guildId } as Parameters<typeof getUserProfile>[0]);
            break;
          case "get_recent_activity":
            result = getRecentActivity({
              ...coerceNumericFields(input, ["days", "limit"]),
              guildId,
            } as Parameters<typeof getRecentActivity>[0]);
            break;
          case "resolve_users_by_name":
            result = resolveUsersByName({
              ...coerceNumericFields(input, ["days", "limit"]),
              guildId,
            } as Parameters<typeof resolveUsersByName>[0]);
            break;
          case "search_audit_log":
            result = await searchAuditLog({
              ...coerceNumericFields(input, ["limit"]),
              guildId,
              client,
            } as Parameters<typeof searchAuditLog>[0]);
            break;
          case "fetch_channel_messages":
            result = await fetchChannelMessages({
              ...coerceNumericFields(input, ["limit"]),
              guildId,
              client,
            } as Parameters<typeof fetchChannelMessages>[0]);
            break;
          case "inspect_image": {
            const { channel_id, message_id } = input as { channel_id: string; message_id: string };
            try {
              const channel = await client.channels.fetch(channel_id);
              if (!channel || !channel.isTextBased()) {
                result = { error: `Channel ${channel_id} is not a text channel` };
                break;
              }
              if (channel.isDMBased() || channel.guildId !== guildId) {
                result = { error: `Channel ${channel_id} does not belong to this guild` };
                break;
              }
              const msg = await channel.messages.fetch(message_id);
              const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
              const urls = [...msg.attachments.values()]
                .filter((a) => a.contentType && imageTypes.some((t) => a.contentType!.startsWith(t)))
                .map((a) => a.url);
              result = { imageUrls: urls };
            } catch (err) {
              result = { error: `Failed to fetch message: ${err}` };
            }
            break;
          }
          case "get_current_member_info":
            result = await getCurrentMemberInfo({
              ...input,
              guildId,
              client,
            } as Parameters<typeof getCurrentMemberInfo>[0]);
            break;
          case "list_guild_channels":
            result = await listGuildChannels({ guildId, client });
            break;
          case "get_channel_info":
            result = await getChannelInfo({
              ...input,
              guildId,
              client,
            } as Parameters<typeof getChannelInfo>[0]);
            break;
          case "list_guild_roles":
            result = await listGuildRoles({ guildId, client });
            break;
          case "update_server_context":
            result = updateServerContextTool({ ...input, guildId } as Parameters<typeof updateServerContextTool>[0]);
            break;
          case "read_memory":
            result = readMemoryTool({ ...input, guildId } as Parameters<typeof readMemoryTool>[0]);
            break;
          case "write_memory":
            result = writeMemoryTool({ ...input, guildId } as Parameters<typeof writeMemoryTool>[0]);
            break;
          case "delete_memory":
            result = deleteMemoryTool({ ...input, guildId } as Parameters<typeof deleteMemoryTool>[0]);
            break;
          case "ask_question":
            // Handled as a special pause — tool result is a placeholder
            result = { _askQuestion: true, question: input.question, choices: input.choices };
            break;
          default:
            result = { error: `Unknown tool: ${call.toolName}` };
        }
      } catch (err) {
        logger.error({ err, tool: call.toolName }, "tool error");
        result = { error: String(err) };
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
    // ask_question — pause the loop, send buttons to Discord
    if (call.toolName === "ask_question" && result && typeof result === "object" && "_askQuestion" in result) {
      const r = result as unknown as { question: string; choices: string[] };
      pendingQuestion = { question: r.question, choices: r.choices };
      askQuestionToolCallId = call.toolCallId;
      toolResultParts.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: "Question sent to moderator. Awaiting their response via button click." },
      });
      continue;
    }

    // inspect_image — collect URLs to inject as image content in the next completion
    if (call.toolName === "inspect_image" && result && typeof result === "object" && "imageUrls" in result) {
      const urls = (result as { imageUrls: string[] }).imageUrls;
      if (urls.length === 0) {
        toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: "No image attachments found on that message." } });
      } else {
        pendingImages.push(...urls);
        toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text", value: `${urls.length} image(s) queued — they will appear in the next message for your analysis.` } });
      }
      continue;
    }

    // Extract users from structured result before converting to plain text
    for (const [id, names] of extractUsersFromResult(result)) {
      if (!discoveredUsers.has(id)) discoveredUsers.set(id, names);
    }

    const content = formatToolResult(call.toolName, result, call.input);
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
          value:
            "ask_question must be called alone — do not combine it with other tool calls in the same turn. Try again with only ask_question.",
        },
      };
    }
    pendingQuestion = undefined;
  }

  return { toolMessage: { role: "tool", content: toolResultParts }, discoveredUsers, pendingImages, pendingQuestion };
}
