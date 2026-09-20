import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.ts";
import type { TaskRow, TaskStatus } from "./contracts.ts";

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { tasks } });
}

function toTaskRow(row: typeof tasks.$inferSelect): TaskRow {
  return { ...row, status: row.status as TaskStatus, threadRefs: JSON.parse(row.threadRefs) };
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
  let random = "";
  for (let i = 0; i < 16; i++) {
    random += ALPHABET[Math.floor(Math.random() * 32)];
  }
  return time + random;
}

/** Durable task registry (Phase 0). Holds pointers only — the runner holds the real transcript. */
export class TaskRegistry {
  constructor(private readonly db: Database) {}

  create(row: Omit<TaskRow, "id" | "createdAt" | "updatedAt">): TaskRow {
    const now = Math.floor(Date.now() / 1000);
    const full: TaskRow = { ...row, id: generateTaskId(), createdAt: now, updatedAt: now };
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
    const rows = ormFor(this.db).select().from(tasks).where(eq(tasks.createdBy, principal)).all();
    return rows.map(toTaskRow);
  }

  updateStatus(id: string, status: TaskStatus, reason?: string): void {
    ormFor(this.db)
      .update(tasks)
      .set({ status, statusReason: reason ?? null, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tasks.id, id))
      .run();
  }

  setNativeSession(id: string, nativeSessionId: string): void {
    ormFor(this.db)
      .update(tasks)
      .set({ nativeSessionId, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tasks.id, id))
      .run();
  }

  setSummary(id: string, summary: string): void {
    ormFor(this.db)
      .update(tasks)
      .set({ summary, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(tasks.id, id))
      .run();
  }
}
