import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getDb } from "./index.ts";

interface ConversationRow {
  thread_id: string;
  guild_id: string;
  messages: string;
  created_at: number;
  updated_at: number;
}

export function loadConversation(threadId: string): ChatCompletionMessageParam[] {
  const db = getDb();
  const row = db
    .query<ConversationRow, [string]>(
      "SELECT * FROM conversations WHERE thread_id = ?",
    )
    .get(threadId);

  if (!row) return [];
  return JSON.parse(row.messages) as ChatCompletionMessageParam[];
}

export function saveConversation(
  threadId: string,
  guildId: string,
  messages: ChatCompletionMessageParam[],
): void {
  const db = getDb();
  const now = Date.now();

  db.run(
    `INSERT INTO conversations (thread_id, guild_id, messages, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       messages = excluded.messages,
       updated_at = excluded.updated_at`,
    [threadId, guildId, JSON.stringify(messages), now, now],
  );
}
