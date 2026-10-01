import type { Database } from "bun:sqlite";
import type { ChatEventMap, ChatHit, SearchRange } from "./events.ts";

export const SNIPPET_MAX = 240;
export const RANGES_MAX = 5;
/** Words of a query that reach FTS; the rest are ignored. */
export const QUERY_TOKENS_MAX = 8;
/** Code points kept before the first match, so the snippet shows some context. */
const LEAD = 60;

const WORD = /[\p{L}\p{N}]+/gu;

/** The query's words, each matched as a word prefix. Only letters and digits survive, so nothing the
 *  owner types can reach FTS5 as syntax. */
export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const m of query.normalize("NFC").matchAll(WORD)) {
    seen.add(m[0].toLowerCase());
    if (seen.size >= QUERY_TOKENS_MAX) break;
  }
  return [...seen];
}

/** An FTS5 MATCH expression: every token as a quoted prefix phrase, implicitly ANDed. null: nothing to match. */
export function ftsQuery(tokens: readonly string[]): string | null {
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" ");
}

type Row = { seq: number; type: "user" | "reply" | "proactive"; data: string; created_at: number };

/**
 * The newest chat messages matching every word of `query`, newest first, at most `limit`. `more` is true
 * when older matches were left out.
 */
export function searchChat(db: Database, query: string, limit: number): { hits: ChatHit[]; more: boolean } {
  const tokens = queryTokens(query);
  const match = ftsQuery(tokens);
  if (!match) return { hits: [], more: false };
  const rows = db
    .query(
      `SELECT e.seq, e.type, e.data, e.created_at FROM web_chat_fts f JOIN web_events e ON e.seq = f.rowid
       WHERE web_chat_fts MATCH ? AND e.type IN ('user','reply','proactive') ORDER BY e.created_at DESC, e.seq DESC LIMIT ?`,
    )
    .all(match, limit + 1) as Row[];
  const hits = rows.slice(0, limit).map((r) => toHit(r, tokens));
  return { hits, more: rows.length > limit };
}

function toHit(r: Row, tokens: readonly string[]): ChatHit {
  const at = new Date(r.created_at).toISOString();
  if (r.type === "user") {
    const d = JSON.parse(r.data) as ChatEventMap["user"];
    return { source: "chat", id: String(r.seq), at: d.at, role: "user", ...snippet(d.text, tokens) };
  }
  const d = JSON.parse(r.data) as ChatEventMap["reply"];
  return { source: "chat", id: String(r.seq), at, role: "agent", ...snippet(d.text, tokens) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One line of at most SNIPPET_MAX code points around the first match, with the matches as code-point ranges. */
export function snippet(text: string, tokens: readonly string[]): { snippet: string; ranges: SearchRange[] } {
  const line = [...text.replace(/\s+/g, " ").trim()];
  const flat = line.join("");
  // Longest first, so "foobar" wins over "foo" at the same place.
  const re = tokens.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...tokens].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "giu") : null;
  const first = re ? re.exec(flat) : null;
  let start = 0;
  if (first && line.length > SNIPPET_MAX) {
    const at = codePointIndex(flat, first.index);
    start = Math.max(0, Math.min(at - LEAD, line.length - SNIPPET_MAX));
  }
  const out = line.slice(start, start + SNIPPET_MAX).join("");
  const ranges: SearchRange[] = [];
  if (re) {
    re.lastIndex = 0;
    for (const m of out.matchAll(re)) {
      if (ranges.length >= RANGES_MAX) break;
      const s = codePointIndex(out, m.index);
      const e = s + [...m[0]].length;
      if (e > s) ranges.push([s, e]);
    }
  }
  return { snippet: out, ranges };
}

function codePointIndex(s: string, unitIndex: number): number {
  return [...s.slice(0, unitIndex)].length;
}
