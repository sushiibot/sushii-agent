import type { CoreToolMessage } from "ai";
import type { Client } from "discord.js";
import { searchMessages } from "../tools/searchMessages.ts";
import { getConversationContext } from "../tools/getConversationContext.ts";
import { getUserProfile } from "../tools/getUserProfile.ts";
import { getRecentActivity } from "../tools/getRecentActivity.ts";
import { getCurrentMemberInfo } from "../tools/getCurrentMemberInfo.ts";
import { searchAuditLog } from "../tools/searchAuditLog.ts";
import { resolveUsersByName } from "../tools/resolveUsersByName.ts";
import { fetchChannelMessages } from "../tools/fetchChannelMessages.ts";

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
  let line = `msg:${row.channel_id}/${row.discord_id} <t:${seconds}:R> <@${row.author_id}>: ${row.content}`;
  if (row.reply_to_id) {
    if (row.reply_to_content != null && row.reply_to_author_id != null) {
      line += `\n  [replying to <@${row.reply_to_author_id}>: ${row.reply_to_content}]`;
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

function formatToolResult(result: unknown): string {
  // Error objects
  if (result && typeof result === "object" && !Array.isArray(result) && "error" in result) {
    return (result as { error: string }).error;
  }

  if (Array.isArray(result)) {
    if (result.length === 0) return "(no results)";
    const first = result[0] as Record<string, unknown>;

    // Audit log entries
    if ("executorId" in first) {
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
            const executor = e.executorId ? `<@${e.executorId}>` : "unknown";
            const target = e.targetId ? `<@${e.targetId}>` : "unknown";
            let line = `<t:${seconds}:R> ${e.action} — ${executor} → ${target}`;
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

    // Message rows (from DB or Discord API — have discord_id)
    if ("discord_id" in first) {
      return result.map((r) => formatMessageRow(r as MessageRowLike)).join("\n");
    }

    // User candidates (resolveUsersByName — have author_id + last_active but no discord_id)
    if ("author_id" in first && "last_active" in first) {
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
            return `<@${u.author_id}> ${name} — last active <t:${seconds}:R>, ${u.message_count} messages`;
          },
        )
        .join("\n");
    }

    return JSON.stringify(result, null, 2);
  }

  // getUserProfile result
  if (result && typeof result === "object" && "summary" in result) {
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

    if (!r.summary || r.summary.total_messages === 0) {
      return "(no messages found for this user in the cache)";
    }

    const lines: string[] = [];
    if (r.summary.first_seen) lines.push(`first seen: <t:${Math.floor(r.summary.first_seen / 1000)}:R>`);
    if (r.summary.last_seen) lines.push(`last seen: <t:${Math.floor(r.summary.last_seen / 1000)}:R>`);
    lines.push(`total messages: ${r.summary.total_messages} across ${r.summary.channel_count} channels`);

    if (r.channelDistribution.length > 0) {
      lines.push("top channels:");
      for (const ch of r.channelDistribution) {
        lines.push(`  <#${ch.channel_id}>: ${ch.count} messages`);
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

  // getCurrentMemberInfo result
  if (result && typeof result === "object" && "userId" in result) {
    const r = result as {
      userId: string;
      isStillInServer: boolean;
      username?: string;
      displayName?: string;
      joinedAt?: number | null;
      roles?: { id: string; name: string }[];
    };

    if (!r.isStillInServer) {
      return `<@${r.userId}> — not in server`;
    }

    const lines: string[] = [];
    lines.push(`user: ${r.username} (<@${r.userId}>)`);
    if (r.displayName && r.displayName !== r.username) lines.push(`display name: ${r.displayName}`);
    if (r.joinedAt) lines.push(`joined: <t:${Math.floor(r.joinedAt / 1000)}:R>`);
    lines.push("in server: yes");
    if (r.roles && r.roles.length > 0) {
      lines.push(`roles: ${r.roles.map((role) => `${role.name} (${role.id})`).join(", ")}`);
    } else {
      lines.push("roles: none");
    }
    return lines.join("\n");
  }

  return JSON.stringify(result, null, 2);
}

type AiToolCall = { toolCallId: string; toolName: string; args: Record<string, unknown> };

export interface RunToolsResult {
  toolMessage: CoreToolMessage;
  discoveredUsers: Map<string, UserNames>;
  pendingImages: string[];
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
        const args = call.args;
        console.log(`[tool] ${call.toolName}`, JSON.stringify(args));

        switch (call.toolName) {
          case "search_messages":
            result = searchMessages({ ...args, guildId } as Parameters<typeof searchMessages>[0]);
            break;
          case "get_conversation_context":
            result = getConversationContext({
              ...args,
              guildId,
            } as Parameters<typeof getConversationContext>[0]);
            break;
          case "get_user_profile":
            result = getUserProfile({ ...args, guildId } as Parameters<typeof getUserProfile>[0]);
            break;
          case "get_recent_activity":
            result = getRecentActivity({
              ...args,
              guildId,
            } as Parameters<typeof getRecentActivity>[0]);
            break;
          case "resolve_users_by_name":
            result = resolveUsersByName({
              ...args,
              guildId,
            } as Parameters<typeof resolveUsersByName>[0]);
            break;
          case "search_audit_log":
            result = await searchAuditLog({
              ...args,
              guildId,
              client,
            } as Parameters<typeof searchAuditLog>[0]);
            break;
          case "fetch_channel_messages":
            result = await fetchChannelMessages({
              ...args,
              client,
            } as Parameters<typeof fetchChannelMessages>[0]);
            break;
          case "inspect_image": {
            const { channel_id, message_id } = args as { channel_id: string; message_id: string };
            try {
              const channel = await client.channels.fetch(channel_id);
              if (!channel || !channel.isTextBased()) {
                result = { error: `Channel ${channel_id} is not a text channel` };
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
              ...args,
              guildId,
              client,
            } as Parameters<typeof getCurrentMemberInfo>[0]);
            break;
          default:
            result = { error: `Unknown tool: ${call.toolName}` };
        }
      } catch (err) {
        console.error(`[tool] ${call.function.name} error:`, err);
        result = { error: String(err) };
      }

      return { call, result };
    }),
  );

  const discoveredUsers = new Map<string, UserNames>();
  const toolResultParts: CoreToolMessage["content"] = [];
  const pendingImages: string[] = [];

  for (const { call, result } of rawResults) {
    // inspect_image — collect URLs to inject as image content in the next completion
    if (call.toolName === "inspect_image" && result && typeof result === "object" && "imageUrls" in result) {
      const urls = (result as { imageUrls: string[] }).imageUrls;
      if (urls.length === 0) {
        toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, result: "No image attachments found on that message." });
      } else {
        pendingImages.push(...urls);
        toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, result: `${urls.length} image(s) queued — they will appear in the next message for your analysis.` });
      }
      continue;
    }

    // Extract users from structured result before converting to plain text
    for (const [id, names] of extractUsersFromResult(result)) {
      if (!discoveredUsers.has(id)) discoveredUsers.set(id, names);
    }

    const content = formatToolResult(result);
    console.log(`[tool] ${call.toolName} result length=${content.length}`);

    toolResultParts.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, result: content });
  }

  return { toolMessage: { role: "tool", content: toolResultParts }, discoveredUsers, pendingImages };
}
