import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, count, eq, sql } from "drizzle-orm";
import type { Changes } from "bun:sqlite";
import type { MemoryEntry, SpaceMemoryStore } from "../contracts.ts";
import { agentMemory, serverContext } from "../../db/schema.ts";

export const MEMORY_LIMIT = 100;

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { agentMemory, serverContext } });
}

interface MemoryRow {
  id: number;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

function toEntry(row: MemoryRow): MemoryEntry {
  return { id: row.id, title: row.title, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at };
}

// Bare query terms are auto-wrapped with `*` for prefix matching, mirroring searchMessages —
// if the query already contains FTS5 operators it's left as-is.
function toFtsQuery(query: string): string {
  if (/[*"()]|\bOR\b|\bAND\b|\bNOT\b|\bNEAR\b/.test(query)) return query;
  return query
    .trim()
    .split(/\s+/)
    .map((term) => `${term}*`)
    .join(" ");
}

/** Phase A: `surface` is always "discord" — `spaceId` keys the existing guild_id column. */
export class DiscordSpaceMemoryStore implements SpaceMemoryStore {
  constructor(private readonly db: Database) {}

  getServerContext(spaceId: string): string | null {
    const row = ormFor(this.db)
      .select({ content: serverContext.content })
      .from(serverContext)
      .where(eq(serverContext.guildId, spaceId))
      .get();
    return row?.content ?? null;
  }

  setServerContext(spaceId: string, content: string): void {
    const updatedAt = Date.now();
    ormFor(this.db)
      .insert(serverContext)
      .values({ guildId: spaceId, content, updatedAt })
      .onConflictDoUpdate({ target: serverContext.guildId, set: { content, updatedAt } })
      .run();
  }

  listTitles(spaceId: string): string[] {
    return ormFor(this.db)
      .select({ title: agentMemory.title })
      .from(agentMemory)
      .where(eq(agentMemory.guildId, spaceId))
      .orderBy(sql`${agentMemory.updatedAt} DESC`)
      .all()
      .map((r) => r.title);
  }

  count(spaceId: string): number {
    const row = ormFor(this.db)
      .select({ count: count() })
      .from(agentMemory)
      .where(eq(agentMemory.guildId, spaceId))
      .get();
    return row?.count ?? 0;
  }

  read(spaceId: string, title: string): MemoryEntry | null {
    const row = ormFor(this.db)
      .select({
        id: agentMemory.id,
        title: agentMemory.title,
        content: agentMemory.content,
        createdAt: agentMemory.createdAt,
        updatedAt: agentMemory.updatedAt,
      })
      .from(agentMemory)
      .where(and(eq(agentMemory.guildId, spaceId), eq(agentMemory.title, title)))
      .get();
    return row ? { id: row.id, title: row.title, content: row.content, createdAt: row.createdAt, updatedAt: row.updatedAt } : null;
  }

  search(spaceId: string, query: string, limit = 5): MemoryEntry[] {
    const rows = this.db
      .query<MemoryRow, [string, string, number]>(
        `SELECT m.id, m.title, m.content, m.created_at, m.updated_at
         FROM agent_memory_fts
         JOIN agent_memory m ON agent_memory_fts.rowid = m.id
         WHERE agent_memory_fts MATCH ? AND m.guild_id = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(toFtsQuery(query), spaceId, limit);
    return rows.map(toEntry);
  }

  upsert(spaceId: string, title: string, content: string): { ok: true } | { error: string } {
    const existing = this.read(spaceId, title);
    if (!existing && this.count(spaceId) >= MEMORY_LIMIT) {
      return { error: `Memory limit reached (${MEMORY_LIMIT}). Delete or update an existing memory before adding a new one.` };
    }

    const now = Date.now();
    ormFor(this.db)
      .insert(agentMemory)
      .values({ guildId: spaceId, title, content, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentMemory.guildId, agentMemory.title],
        set: { content, updatedAt: now },
      })
      .run();
    return { ok: true };
  }

  delete(spaceId: string, title: string): boolean {
    const result = ormFor(this.db)
      .delete(agentMemory)
      .where(and(eq(agentMemory.guildId, spaceId), eq(agentMemory.title, title)))
      .run() as unknown as Changes;
    return (result.changes ?? 0) > 0;
  }
}
