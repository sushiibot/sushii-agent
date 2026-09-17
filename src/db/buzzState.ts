import { eq } from "drizzle-orm";
import { getOrm } from "./index.ts";
import { buzzState } from "./schema.ts";

const CURSOR_ID = "cursor";

/** Last-processed mention `created_at` (unix seconds); 0 when the surface has never run. */
export function getBuzzCursor(): number {
  const row = getOrm().select().from(buzzState).where(eq(buzzState.id, CURSOR_ID)).get();
  return row?.lastCursor ?? 0;
}

export function setBuzzCursor(cursor: number): void {
  getOrm()
    .insert(buzzState)
    .values({ id: CURSOR_ID, lastCursor: cursor })
    .onConflictDoUpdate({ target: buzzState.id, set: { lastCursor: cursor } })
    .run();
}
