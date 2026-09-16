import { eq, lt } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { getOrm } from "./index.ts";
import { conversations } from "./schema.ts";

const MAX_HISTORY_MESSAGES = 200;

export interface ConversationData {
  messages: ModelMessage[];
  initialThreadContext: string | null;
}

export function loadConversation(threadId: string): ConversationData {
  const orm = getOrm();
  const row = orm.select().from(conversations).where(eq(conversations.threadId, threadId)).get();

  if (!row) return { messages: [], initialThreadContext: null };
  return {
    messages: JSON.parse(row.messages) as ModelMessage[],
    initialThreadContext: row.initialThreadContext,
  };
}

export function saveConversation(
  threadId: string,
  guildId: string,
  messages: ModelMessage[],
  initialThreadContext: string | null,
): void {
  const orm = getOrm();
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
  // If no user message exists in the trimmed window (extreme edge case), keep the
  // untrimmed slice rather than silently wiping the conversation.
  const safeMsgs = startIdx > 0 && startIdx < messagesToSave.length
    ? messagesToSave.slice(startIdx)
    : messagesToSave;

  orm
    .insert(conversations)
    .values({
      threadId,
      guildId,
      messages: JSON.stringify(safeMsgs),
      initialThreadContext,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: conversations.threadId,
      set: { messages: JSON.stringify(safeMsgs), updatedAt: now },
    })
    .run();
}

export function deleteStaleConversations(maxAgeMs: number): void {
  const orm = getOrm();
  const cutoff = Date.now() - maxAgeMs;
  orm.delete(conversations).where(lt(conversations.updatedAt, cutoff)).run();
}
