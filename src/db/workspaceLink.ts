import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { asc, eq, lt } from "drizzle-orm";
import { kv, workspaceInbox, workspaceOutboxSeen } from "./schema.ts";

// All timestamps here are unix milliseconds.

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { kv, workspaceInbox, workspaceOutboxSeen } });
}

export interface InboxRow {
  id: number;
  principalId: string;
  userText: string;
  replyText: string;
  createdAt: number;
}

/** Persistence behind the workspace link; the gateway passes the real DB, tests an in-memory one. */
export class WorkspaceLinkStore {
  constructor(private readonly db: Database) {}

  hasSeenOutbox(outboxId: string): boolean {
    return ormFor(this.db).select().from(workspaceOutboxSeen).where(eq(workspaceOutboxSeen.outboxId, outboxId)).get() !== undefined;
  }

  markOutboxSeen(outboxId: string, principalId: string, now = Date.now()): void {
    ormFor(this.db).insert(workspaceOutboxSeen).values({ outboxId, principalId, seenAt: now }).onConflictDoNothing().run();
  }

  pruneOutboxSeen(maxAgeMs: number, now = Date.now()): void {
    ormFor(this.db).delete(workspaceOutboxSeen).where(lt(workspaceOutboxSeen.seenAt, now - maxAgeMs)).run();
  }

  addInbox(principalId: string, userText: string, replyText: string, now = Date.now()): void {
    ormFor(this.db).insert(workspaceInbox).values({ principalId, userText, replyText, createdAt: now }).run();
  }

  /** Oldest first. */
  listInbox(principalId: string): InboxRow[] {
    return ormFor(this.db).select().from(workspaceInbox).where(eq(workspaceInbox.principalId, principalId)).orderBy(asc(workspaceInbox.id)).all();
  }

  deleteInbox(id: number): void {
    ormFor(this.db).delete(workspaceInbox).where(eq(workspaceInbox.id, id)).run();
  }

  getKv(key: string): string | null {
    return ormFor(this.db).select().from(kv).where(eq(kv.key, key)).get()?.value ?? null;
  }

  setKv(key: string, value: string): void {
    ormFor(this.db).insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
  }
}
