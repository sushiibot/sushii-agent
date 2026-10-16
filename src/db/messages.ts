import { MessageType, type Message } from "discord.js";
import { CONTENT_RETENTION_MS, purgeMessageCache } from "./retention.ts";
import { config } from "../config.ts";
import { getDb } from "./index.ts";
import { buildMessageContent } from "../utils/flattenMessage.ts";
import { getLogger } from "../logger.ts";

const logger = getLogger("db");

/** Without the MessageContent intent, Discord blanks every guild message except the bot's own and
 *  ones that mention it, so only those carry text worth storing. */
export function hasMessageContent(message: Message): boolean {
  if (config.discordMessageContent) return true;
  const botId = message.client.user?.id;
  if (!botId) return false;
  return message.author.id === botId || message.mentions.users.has(botId);
}

export function insertMessage(message: Message): void {
  if (!message.guildId || message.createdTimestamp <= Date.now() - CONTENT_RETENTION_MS) return;
  if (!hasMessageContent(message)) return;

  const db = getDb();
  const displayName = message.member?.displayName ?? message.author.displayName;

  const content = buildMessageContent(message);
  // channel_id is the thread's own snowflake for a message posted inside a thread, distinct
  // from the channel it lives under — parent_channel_id is the only place that link survives.
  const parentChannelId = message.channel.isThread() ? message.channel.parentId : null;

  db.run(
    `INSERT OR IGNORE INTO messages
      (discord_id, guild_id, channel_id, parent_channel_id, author_id, content, reply_to_id,
       created_at, author_username, author_display_name, is_automod, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.guildId,
      message.channelId,
      parentChannelId,
      message.author.id,
      content,
      message.reference?.messageId ?? null,
      message.createdTimestamp,
      message.author.username,
      displayName !== message.author.username ? displayName : null,
      message.type === MessageType.AutoModerationAction ? 1 : 0,
      message.author.bot ? 1 : 0,
    ],
  );
}

export function updateMessageContent(
  discordId: string,
  content: string,
  editedAt: number,
): void {
  const db = getDb();
  db.run(
    `UPDATE messages SET content = ?, edited_at = ? WHERE discord_id = ?`,
    [content, editedAt, discordId],
  );
}

export function softDeleteMessage(discordId: string): void {
  const db = getDb();
  db.run(
    `UPDATE messages SET deleted_at = ? WHERE discord_id = ?`,
    [Date.now(), discordId],
  );
}

export function deleteOldMessages(): void {
  const db = getDb();
  const result = { changes: purgeMessageCache(db) };
  if (result.changes > 0) {
    logger.info({ changes: result.changes }, "deleted old messages");
  }

  // Optimize FTS index after bulk deletions (merges segments without full reconstruction)
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')");
}
