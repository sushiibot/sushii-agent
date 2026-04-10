import { MessageType, type Message } from "discord.js";
import { getDb } from "./index.ts";
import { buildMessageContent } from "../utils/flattenMessage.ts";
import { getLogger } from "../logger.ts";

const logger = getLogger("db");

export function insertMessage(message: Message): void {
  if (!message.guildId) return;

  const db = getDb();
  const displayName = message.member?.displayName ?? message.author.displayName;

  const content = buildMessageContent(message);

  db.run(
    `INSERT OR IGNORE INTO messages
      (discord_id, guild_id, channel_id, author_id, content, reply_to_id, created_at,
       author_username, author_display_name, is_automod, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.guildId,
      message.channelId,
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
  const threshold = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const result = db.run(`DELETE FROM messages WHERE created_at < ?`, [threshold]);
  if (result.changes > 0) {
    logger.info({ changes: result.changes }, "deleted old messages");
  }

  // Rebuild FTS index after bulk deletions
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}
