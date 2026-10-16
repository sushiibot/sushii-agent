import { CONTENT_RETENTION_MS } from "../../db/retention.ts";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, lte } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { ConversationData, ConversationRef, ConversationStore } from "../contracts.ts";
import { conversations } from "../../db/schema.ts";

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { conversations } });
}

/** Surface-agnostic conversation store over the `conversations` table. Keyed by `conversationId`
 *  (the `thread_id` column) — safe across surfaces because conversation ids are globally unique per
 *  surface (Nostr event ids vs Discord snowflakes never collide), so no `surface` column is needed
 *  (see U6 FINDINGS: the re-key migration is deferred). `spaceId` writes the `guild_id` column. */
export class SqliteConversationStore implements ConversationStore {
  // Retain the original lifetime across an in-flight turn, even if cleanup deletes its row.
  private readonly loadedAt = new WeakMap<ConversationRef, number>();
  constructor(private readonly db: Database) {}

  load(ref: ConversationRef): ConversationData {
    this.deleteStale(CONTENT_RETENTION_MS);
    const row = ormFor(this.db)
      .select()
      .from(conversations)
      .where(eq(conversations.threadId, ref.conversationId))
      .get();

    this.loadedAt.set(ref, row?.createdAt ?? Date.now());
    if (!row) return { messages: [], initialThreadContext: null };
    return {
      messages: JSON.parse(row.messages) as ModelMessage[],
      initialThreadContext: row.initialThreadContext,
    };
  }

  save(ref: ConversationRef, data: ConversationData): void {
    const now = Date.now();
    const existing = ormFor(this.db).select().from(conversations)
      .where(eq(conversations.threadId, ref.conversationId)).get();
    const createdAt = this.loadedAt.get(ref) ?? existing?.createdAt ?? now;
    if (createdAt <= now - CONTENT_RETENTION_MS) {
      ormFor(this.db).delete(conversations).where(eq(conversations.threadId, ref.conversationId)).run();
      return; // An expired in-flight history must not be inserted as a new conversation.
    }

    // Persist history as-is. Budget and history validity are owned by the Compactor (summarize-fold
    // on user-turn boundaries); a front-slice here would shift the prompt prefix and strip a leading
    // compaction summary.
    const messages = JSON.stringify(data.messages);

    ormFor(this.db)
      .insert(conversations)
      .values({
        threadId: ref.conversationId,
        guildId: ref.spaceId,
        messages,
        initialThreadContext: data.initialThreadContext,
        createdAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: conversations.threadId,
        set: { messages, updatedAt: now },
      })
      .run();
  }

  deleteStale(maxAgeMs: number): void {
    const cutoff = Date.now() - Math.min(maxAgeMs, CONTENT_RETENTION_MS);
    ormFor(this.db).delete(conversations).where(lte(conversations.createdAt, cutoff)).run();
  }
}
