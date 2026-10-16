import type { Database } from "bun:sqlite";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CONTENT_RETENTION_MS = 30 * DAY_MS;
// Delete early to leave room for scheduling delays. Reads also enforce the hard cap.
export const CLEANUP_RETENTION_MS = 29 * DAY_MS;
export const RETENTION_SWEEP_MS = 60 * 60 * 1000;

export function purgeMessageCache(db: Database, now = Date.now(), maxAgeMs = CONTENT_RETENTION_MS): number {
  return db.run("DELETE FROM messages WHERE created_at <= ?", [now - maxAgeMs]).changes;
}

export function purgeScreening(db: Database, now = Date.now(), maxAgeMs = CONTENT_RETENTION_MS): number {
  return db.run("DELETE FROM screening_verdicts WHERE created_at <= ?", [now - maxAgeMs]).changes;
}

/** Creation time is intentional: editing or continuing a record must not renew its lifetime. */
export function purgeRetainedContent(db: Database, now = Date.now(), maxAgeMs = CLEANUP_RETENTION_MS): void {
  db.transaction(() => {
    purgeMessageCache(db, now, maxAgeMs);
    purgeScreening(db, now, maxAgeMs);
    db.run("UPDATE screening_verdicts SET judged = NULL WHERE flagged = 0 AND judged IS NOT NULL");
    db.run("DELETE FROM conversations WHERE created_at <= ?", [now - maxAgeMs]);
    db.run("DELETE FROM pending_questions WHERE created_at <= ?", [now - DAY_MS]);
  })();
}
