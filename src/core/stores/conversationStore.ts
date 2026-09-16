import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, lt } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { ConversationData, ConversationRef, ConversationStore } from "../contracts.ts";
import { conversations } from "../../db/schema.ts";

const MAX_HISTORY_MESSAGES = 200;

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { conversations } });
}

/** Phase A: `surface` is always "discord" — `spaceId`/`conversationId` key the existing
 *  guild_id/thread_id columns directly, no schema change. */
export class DiscordConversationStore implements ConversationStore {
  constructor(private readonly db: Database) {}

  load(ref: ConversationRef): ConversationData {
    const row = ormFor(this.db)
      .select()
      .from(conversations)
      .where(eq(conversations.threadId, ref.conversationId))
      .get();

    if (!row) return { messages: [], initialThreadContext: null };
    return {
      messages: JSON.parse(row.messages) as ModelMessage[],
      initialThreadContext: row.initialThreadContext,
    };
  }

  save(ref: ConversationRef, data: ConversationData): void {
    const now = Date.now();

    const messagesToSave = data.messages.length > MAX_HISTORY_MESSAGES
      ? data.messages.slice(data.messages.length - MAX_HISTORY_MESSAGES)
      : data.messages;

    // Walk forward past any orphaned tool/system messages at the front that may have been
    // created by slicing between an assistant tool-call message and its tool results — the LLM
    // API rejects histories that start with tool results without a preceding tool call.
    let startIdx = 0;
    while (startIdx < messagesToSave.length && messagesToSave[startIdx].role !== "user") {
      startIdx++;
    }
    // If no user message exists in the trimmed window (extreme edge case), keep the untrimmed
    // slice rather than silently wiping the conversation.
    const safeMsgs = startIdx > 0 && startIdx < messagesToSave.length
      ? messagesToSave.slice(startIdx)
      : messagesToSave;

    ormFor(this.db)
      .insert(conversations)
      .values({
        threadId: ref.conversationId,
        guildId: ref.spaceId,
        messages: JSON.stringify(safeMsgs),
        initialThreadContext: data.initialThreadContext,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: conversations.threadId,
        set: { messages: JSON.stringify(safeMsgs), updatedAt: now },
      })
      .run();
  }

  deleteStale(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    ormFor(this.db).delete(conversations).where(lt(conversations.updatedAt, cutoff)).run();
  }
}
