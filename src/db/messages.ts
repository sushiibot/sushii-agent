import type { Message } from "discord.js";
import { config } from "../config.ts";
import { getDb } from "./index.ts";

export function insertMessage(message: Message): void {
  if (!message.guildId) return;

  const db = getDb();
  db.run(
    `INSERT OR IGNORE INTO messages
      (discord_id, guild_id, channel_id, author_id, content, reply_to_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.guildId,
      message.channelId,
      message.author.id,
      message.content ?? "",
      message.reference?.messageId ?? null,
      message.createdTimestamp,
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

  for (const guildId of Object.keys(config.guildConfig)) {
    const result = db.run(
      `DELETE FROM messages WHERE created_at < ? AND guild_id = ?`,
      [threshold, guildId],
    );
    if (result.changes > 0) {
      console.log(`Deleted ${result.changes} old messages from guild ${guildId}`);
    }
  }

  // Rebuild FTS index after bulk deletions
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}
