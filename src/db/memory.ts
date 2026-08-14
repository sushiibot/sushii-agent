import { getDb } from "./index.ts";

export const MEMORY_LIMIT = 100;

// --- Server Context ---

export function getServerContext(guildId: string): string | null {
  const db = getDb();
  const row = db.query<{ content: string }, [string]>(
    "SELECT content FROM server_context WHERE guild_id = ?",
  ).get(guildId);
  return row?.content ?? null;
}

export function setServerContext(guildId: string, content: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO server_context (guild_id, content, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [guildId, content, Date.now()],
  );
}

// --- Agent Memory ---

export interface MemoryRow {
  id: number;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export function getMemoryCount(guildId: string): number {
  const db = getDb();
  const row = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM agent_memory WHERE guild_id = ?",
  ).get(guildId);
  return row?.count ?? 0;
}

export function listMemoryTitles(guildId: string): string[] {
  const db = getDb();
  return db.query<{ title: string }, [string]>(
    "SELECT title FROM agent_memory WHERE guild_id = ? ORDER BY updated_at DESC",
  ).all(guildId).map((r) => r.title);
}

export function readMemory(guildId: string, title: string): MemoryRow | null {
  const db = getDb();
  return db.query<MemoryRow, [string, string]>(
    "SELECT id, title, content, created_at, updated_at FROM agent_memory WHERE guild_id = ? AND title = ?",
  ).get(guildId, title);
}

export function readAllMemories(guildId: string): MemoryRow[] {
  const db = getDb();
  return db.query<MemoryRow, [string]>(
    "SELECT id, title, content, created_at, updated_at FROM agent_memory WHERE guild_id = ? ORDER BY updated_at DESC",
  ).all(guildId);
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
  const db = getDb();
  const existing = readMemory(guildId, title);
  if (!existing && getMemoryCount(guildId) >= MEMORY_LIMIT) {
    return { error: `Memory limit reached (${MEMORY_LIMIT}). Delete or update an existing memory before adding a new one.` };
  }

  const now = Date.now();
  db.run(
    `INSERT INTO agent_memory (guild_id, title, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, title) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [guildId, title, content, now, now],
  );
  return { ok: true };
}

export function deleteMemory(guildId: string, title: string): boolean {
  const db = getDb();
  const result = db.run(
    "DELETE FROM agent_memory WHERE guild_id = ? AND title = ?",
    [guildId, title],
  );
  return (result.changes ?? 0) > 0;
}
