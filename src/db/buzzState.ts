import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { buzzState } from "./schema.ts";

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { buzzState } });
}

/** Last-processed mention `created_at` (unix seconds) for one relay/community; 0 when never run.
 *  `key` is the relay URL — each community has its own cursor since mentions are host-scoped. */
export function getBuzzCursor(db: Database, key: string): number {
  const row = ormFor(db).select().from(buzzState).where(eq(buzzState.id, key)).get();
  return row?.lastCursor ?? 0;
}

export function setBuzzCursor(db: Database, key: string, cursor: number): void {
  ormFor(db)
    .insert(buzzState)
    .values({ id: key, lastCursor: cursor })
    .onConflictDoUpdate({ target: buzzState.id, set: { lastCursor: cursor } })
    .run();
}
