import type { ModelMessage } from "ai";
import { getDb } from "./index.ts";

const MAX_HISTORY_MESSAGES = 200;

interface ConversationRow {
  thread_id: string;
  guild_id: string;
  messages: string;
  initial_thread_context: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationData {
  messages: ModelMessage[];
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
    messages: JSON.parse(row.messages) as ModelMessage[],
    initialThreadContext: row.initial_thread_context,
  };
}

export function saveConversation(
  threadId: string,
  guildId: string,
  messages: ModelMessage[],
  initialThreadContext: string | null,
): void {
  const db = getDb();
  const now = Date.now();

  const messagesToSave = messages.length > MAX_HISTORY_MESSAGES
    ? messages.slice(messages.length - MAX_HISTORY_MESSAGES)
    : messages;

  // Walk forward past any orphaned tool/system messages at the front that
  // may have been created by slicing between an assistant tool-call message
  // and its corresponding tool result messages. The LLM API rejects histories
  // that start with tool results without a preceding tool call.
  let startIdx = 0;
  while (startIdx < messagesToSave.length && messagesToSave[startIdx].role !== "user") {
    startIdx++;
  }
  const safeMsgs = startIdx > 0 ? messagesToSave.slice(startIdx) : messagesToSave;

  db.run(
    `INSERT INTO conversations (thread_id, guild_id, messages, initial_thread_context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       messages = excluded.messages,
       updated_at = excluded.updated_at`,
    [threadId, guildId, JSON.stringify(safeMsgs), initialThreadContext, now, now],
  );
}

export function deleteStaleConversations(maxAgeMs: number): void {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  db.run("DELETE FROM conversations WHERE updated_at < ?", [cutoff]);
}
