import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq } from "drizzle-orm";
import { slackMessages, slackSyncState } from "./schema.ts";

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { slackMessages, slackSyncState } });
}

export type SlackMessageRow = typeof slackMessages.$inferInsert;
export type SlackSyncStateRow = typeof slackSyncState.$inferSelect;

/** Idempotent upsert keyed on (channel, ts): a re-ingested message (backfill overlapping the live
 *  stream, an edit) replaces the row, second write wins. Content columns are always set from the row,
 *  so this must never run for a `message_deleted` event (no content) — use `markSlackMessageDeleted`. */
export function upsertSlackMessage(db: Database, row: SlackMessageRow): void {
  ormFor(db)
    .insert(slackMessages)
    .values(row)
    .onConflictDoUpdate({
      target: [slackMessages.channel, slackMessages.ts],
      set: {
        threadTs: row.threadTs ?? null,
        user: row.user ?? null,
        botId: row.botId ?? null,
        subtype: row.subtype ?? null,
        text: row.text ?? "",
        blocks: row.blocks ?? null,
        files: row.files ?? null,
        team: row.team ?? null,
        editedTs: row.editedTs ?? null,
        createdAt: row.createdAt,
        rawJson: row.rawJson,
        ingestedAt: row.ingestedAt,
      },
    })
    .run();
}

/** Tombstone for a `message_deleted` event. The delete payload carries no content, so the
 *  conflict-set touches only `deletedAt`/`rawJson` — an already-archived message keeps its text.
 *  If the message was never ingested, insert from `previous_message` (which does carry content). */
export function markSlackMessageDeleted(db: Database, row: SlackMessageRow & { deletedAt: number }): void {
  ormFor(db)
    .insert(slackMessages)
    .values(row)
    .onConflictDoUpdate({
      target: [slackMessages.channel, slackMessages.ts],
      set: { deletedAt: row.deletedAt, rawJson: row.rawJson },
    })
    .run();
}

export function getSlackSyncState(db: Database, channel: string): SlackSyncStateRow | undefined {
  return ormFor(db).select().from(slackSyncState).where(eq(slackSyncState.channel, channel)).get();
}

/** Upsert a partial patch of the per-channel cursor. Missing fields keep their stored value. */
export function setSlackSyncState(
  db: Database,
  channel: string,
  patch: { oldestBackfilled?: string | null; latestSeen?: string | null },
): void {
  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now };
  if ("oldestBackfilled" in patch) set["oldestBackfilled"] = patch.oldestBackfilled ?? null;
  if ("latestSeen" in patch) set["latestSeen"] = patch.latestSeen ?? null;
  ormFor(db)
    .insert(slackSyncState)
    .values({
      channel,
      oldestBackfilled: patch.oldestBackfilled ?? null,
      latestSeen: patch.latestSeen ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: slackSyncState.channel, set })
    .run();
}

/** Test/query helper: fetch one archived row. */
export function getSlackMessage(db: Database, channel: string, ts: string): typeof slackMessages.$inferSelect | undefined {
  return ormFor(db)
    .select()
    .from(slackMessages)
    .where(and(eq(slackMessages.channel, channel), eq(slackMessages.ts, ts)))
    .get();
}
