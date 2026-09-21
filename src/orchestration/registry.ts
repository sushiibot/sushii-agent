import type { Changes, Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { runnerRouting, tasks } from "../db/schema.ts";
import type { TaskRow, TaskStatus } from "./contracts.ts";

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { tasks, runnerRouting } });
}

function parseThreadRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toTaskRow(row: typeof tasks.$inferSelect): TaskRow {
  return { ...row, threadRefs: parseThreadRefs(row.threadRefs) };
}

export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`TaskRegistry: unknown task id "${id}"`);
  }
}

/** Generates a ULID-shaped id (26 chars, Crockford base32) without pulling in a dependency. */
export function generateTaskId(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const timeMs = Date.now();
  let time = "";
  let t = timeMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  let random = "";
  for (let i = 0; i < 16; i++) {
    random += ALPHABET[randomBytes[i] % 32];
  }
  return time + random;
}

function assertChanged(result: Changes, id: string): void {
  if ((result.changes ?? 0) === 0) throw new TaskNotFoundError(id);
}

/** Durable task registry (Phase 0). Holds pointers only — the runner holds the real transcript. */
export class TaskRegistry {
  constructor(private readonly db: Database) {}

  create(row: Omit<TaskRow, "id" | "createdAt" | "updatedAt" | "archivedAt">): TaskRow {
    const now = Math.floor(Date.now() / 1000);
    const full: TaskRow = { ...row, id: generateTaskId(), createdAt: now, updatedAt: now, archivedAt: null };
    ormFor(this.db)
      .insert(tasks)
      .values({ ...full, threadRefs: JSON.stringify(full.threadRefs) })
      .run();
    return full;
  }

  get(id: string): TaskRow | undefined {
    const row = ormFor(this.db).select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? toTaskRow(row) : undefined;
  }

  listByPrincipal(principal: string): TaskRow[] {
    const rows = ormFor(this.db)
      .select()
      .from(tasks)
      .where(eq(tasks.createdBy, principal))
      .orderBy(desc(tasks.createdAt))
      .all();
    return rows.map(toTaskRow);
  }

  /** Clearing `reason` (by omitting it) is intentional: a status change without an explicit reason wipes the prior one. */
  updateStatus(id: string, status: TaskStatus, reason?: string): void {
    const result = ormFor(this.db)
      .update(tasks)
      .set({ status, statusReason: reason ?? null, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tasks.id, id))
      .run() as unknown as Changes;
    assertChanged(result, id);
  }

  /** Reconciliation for the no-catch-up gap (until U1.2): when a runner (re)registers, the
   *  orchestrator has no live stream to any task it thought was still running on that runner — a
   *  fresh connection can't observe an in-flight turn's result. Mark those `running` rows `failed`
   *  so the roster stays honest instead of showing phantoms. Returns how many were reconciled. */
  failRunningForRunner(runnerId: string, reason: string): number {
    const result = ormFor(this.db)
      .update(tasks)
      .set({ status: "failed", statusReason: reason, updatedAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(tasks.runnerId, runnerId), eq(tasks.status, "running")))
      .run() as unknown as Changes;
    return result.changes ?? 0;
  }

  /** Archive settled (idle/done/failed) tasks whose last update is older than `cutoffUnixSec`, so
   *  they drop out of the live roster. Never touches running tasks or already-archived rows.
   *  Returns how many were archived. The transcript on the runner is untouched — still resumable. */
  archiveIdleBefore(cutoffUnixSec: number): number {
    const now = Math.floor(Date.now() / 1000);
    const result = ormFor(this.db)
      .update(tasks)
      .set({ archivedAt: now })
      .where(
        and(
          isNull(tasks.archivedAt),
          lt(tasks.updatedAt, cutoffUnixSec),
          inArray(tasks.status, ["idle", "done", "failed"]),
        ),
      )
      .run() as unknown as Changes;
    return result.changes ?? 0;
  }

  /** Clear the archived flag — called when an archived task is resumed so it rejoins the roster. */
  unarchive(id: string): void {
    ormFor(this.db)
      .update(tasks)
      .set({ archivedAt: null })
      .where(eq(tasks.id, id))
      .run();
  }

  setNativeSession(id: string, nativeSessionId: string): void {
    const result = ormFor(this.db)
      .update(tasks)
      .set({ nativeSessionId, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tasks.id, id))
      .run() as unknown as Changes;
    assertChanged(result, id);
  }

  setSummary(id: string, summary: string): void {
    const result = ormFor(this.db)
      .update(tasks)
      .set({ summary, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tasks.id, id))
      .run() as unknown as Changes;
    assertChanged(result, id);
  }

  /** Remembered runner for a (principal, project), or undefined. */
  getRoutingPref(principal: string, projectKey: string): string | undefined {
    const row = ormFor(this.db)
      .select()
      .from(runnerRouting)
      .where(and(eq(runnerRouting.principal, principal), eq(runnerRouting.projectKey, projectKey)))
      .get();
    return row?.runnerId;
  }

  /** Persist the runner chosen for a (principal, project) so future dispatches route without asking. */
  setRoutingPref(principal: string, projectKey: string, runnerId: string): void {
    ormFor(this.db)
      .insert(runnerRouting)
      .values({ principal, projectKey, runnerId, updatedAt: Math.floor(Date.now() / 1000) })
      .onConflictDoUpdate({
        target: [runnerRouting.principal, runnerRouting.projectKey],
        set: { runnerId, updatedAt: Math.floor(Date.now() / 1000) },
      })
      .run();
  }
}
