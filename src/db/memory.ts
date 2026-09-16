import type { Changes } from "bun:sqlite";
import { and, count, eq, sql } from "drizzle-orm";
import { getDb, getOrm } from "./index.ts";
import { agentMemory, serverContext } from "./schema.ts";

export const MEMORY_LIMIT = 100;

// --- Server Context ---

export function getServerContext(guildId: string): string | null {
  const orm = getOrm();
  const row = orm
    .select({ content: serverContext.content })
    .from(serverContext)
    .where(eq(serverContext.guildId, guildId))
    .get();
  return row?.content ?? null;
}

export function setServerContext(guildId: string, content: string): void {
  const orm = getOrm();
  const updatedAt = Date.now();
  orm
    .insert(serverContext)
    .values({ guildId, content, updatedAt })
    .onConflictDoUpdate({ target: serverContext.guildId, set: { content, updatedAt } })
    .run();
}

// --- Agent Memory ---

export interface MemoryRow {
  id: number;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

function toMemoryRow(row: {
  id: number;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}): MemoryRow {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function getMemoryCount(guildId: string): number {
  const orm = getOrm();
  const row = orm
    .select({ count: count() })
    .from(agentMemory)
    .where(eq(agentMemory.guildId, guildId))
    .get();
  return row?.count ?? 0;
}

export function listMemoryTitles(guildId: string): string[] {
  const orm = getOrm();
  return orm
    .select({ title: agentMemory.title })
    .from(agentMemory)
    .where(eq(agentMemory.guildId, guildId))
    .orderBy(sql`${agentMemory.updatedAt} DESC`)
    .all()
    .map((r) => r.title);
}

export function readMemory(guildId: string, title: string): MemoryRow | null {
  const orm = getOrm();
  const row = orm
    .select({
      id: agentMemory.id,
      title: agentMemory.title,
      content: agentMemory.content,
      createdAt: agentMemory.createdAt,
      updatedAt: agentMemory.updatedAt,
    })
    .from(agentMemory)
    .where(and(eq(agentMemory.guildId, guildId), eq(agentMemory.title, title)))
    .get();
  return row ? toMemoryRow(row) : null;
}

export function readAllMemories(guildId: string): MemoryRow[] {
  const orm = getOrm();
  return orm
    .select({
      id: agentMemory.id,
      title: agentMemory.title,
      content: agentMemory.content,
      createdAt: agentMemory.createdAt,
      updatedAt: agentMemory.updatedAt,
    })
    .from(agentMemory)
    .where(eq(agentMemory.guildId, guildId))
    .orderBy(sql`${agentMemory.updatedAt} DESC`)
    .all()
    .map(toMemoryRow);
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

export function searchMemories(guildId: string, query: string, limit = 5): MemoryRow[] {
  const db = getDb();
  return db.query<MemoryRow, [string, string, number]>(
    `SELECT m.id, m.title, m.content, m.created_at, m.updated_at
     FROM agent_memory_fts
     JOIN agent_memory m ON agent_memory_fts.rowid = m.id
     WHERE agent_memory_fts MATCH ? AND m.guild_id = ?
     ORDER BY rank
     LIMIT ?`,
  ).all(toFtsQuery(query), guildId, limit);
}

export function upsertMemory(
  guildId: string,
  title: string,
  content: string,
): { ok: true } | { error: string } {
  const orm = getOrm();
  const existing = readMemory(guildId, title);
  if (!existing && getMemoryCount(guildId) >= MEMORY_LIMIT) {
    return { error: `Memory limit reached (${MEMORY_LIMIT}). Delete or update an existing memory before adding a new one.` };
  }

  const now = Date.now();
  orm
    .insert(agentMemory)
    .values({ guildId, title, content, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [agentMemory.guildId, agentMemory.title],
      set: { content, updatedAt: now },
    })
    .run();
  return { ok: true };
}

export function deleteMemory(guildId: string, title: string): boolean {
  const orm = getOrm();
  const result = orm
    .delete(agentMemory)
    .where(and(eq(agentMemory.guildId, guildId), eq(agentMemory.title, title)))
    .run() as unknown as Changes;
  return (result.changes ?? 0) > 0;
}
