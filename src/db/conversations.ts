import type { CoreMessage } from "ai";
import { getDb } from "./index.ts";

interface ConversationRow {
  thread_id: string;
  guild_id: string;
  messages: string;
  initial_thread_context: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationData {
  messages: CoreMessage[];
  initialThreadContext: string | null;
}

export function loadConversation(threadId: string): ConversationData {
  const db = getDb();
  const row = db
    .query<ConversationRow, [string]>(
      "SELECT * FROM conversations WHERE thread_id = ?",
    )
    .get(threadId);

  if (!row) return { messages: [], initialThreadContext: null };
  return {
    messages: JSON.parse(row.messages) as CoreMessage[],
    initialThreadContext: row.initial_thread_context,
  };
}

export function saveConversation(
  threadId: string,
  guildId: string,
  messages: CoreMessage[],
  initialThreadContext: string,
): void {
  const db = getDb();
  const now = Date.now();

  db.run(
    `INSERT INTO conversations (thread_id, guild_id, messages, initial_thread_context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       messages = excluded.messages,
       updated_at = excluded.updated_at`,
    [threadId, guildId, JSON.stringify(messages), initialThreadContext, now, now],
  );
}
