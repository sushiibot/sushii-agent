import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, lt } from "drizzle-orm";
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
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: conversations.threadId,
        set: { messages, updatedAt: now },
      })
      .run();
  }

  deleteStale(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    ormFor(this.db).delete(conversations).where(lt(conversations.updatedAt, cutoff)).run();
  }
}
