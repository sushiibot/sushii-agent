import type { Database } from "bun:sqlite";
import { getLogger } from "../../logger.ts";
import type { ChatEventMap, ChatHit, SearchRange } from "./events.ts";

const log = getLogger("web/chatSearch");

export const SNIPPET_MAX = 240;
export const RANGES_MAX = 5;
/** Words of a query that reach FTS; the rest are ignored. */
export const QUERY_TOKENS_MAX = 8;
/** Code points kept before the first match, so the snippet shows some context. */
const LEAD = 60;
/** Rounds of rowids fetched per search; each skips index entries whose chat row is gone. */
const FETCH_ROUNDS = 3;

/** Chat items with searchable text. A job alert carries its plain-text form, as pre-alert bots stored it. */
export const CHAT_INDEX_TYPES = ["user", "reply", "proactive", "alert"] as const;
const CHAT_TYPES_SQL = CHAT_INDEX_TYPES.map((t) => `'${t}'`).join(",");
const HIGH_KEY = "web_chat_fts:indexed_through";
const LOW_KEY = "web_chat_fts:indexed_below";

// Marks stay in a word: FTS tokenizes inside the quoted phrase itself, so a word it splits becomes a phrase.
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * Keeps `web_chat_fts` in step with the chat rows. Indexing is best-effort: a broken index must never
 * fail a chat write, so failures are logged and `catchUp` fills the gaps later.
 */
export class ChatIndex {
  constructor(private readonly db: Database) {}

  add(seq: number, text: string): void {
    try {
      this.db.query("INSERT OR REPLACE INTO web_chat_fts (rowid, text) VALUES (?, ?)").run(seq, text);
    } catch (err) {
      log.warn({ err, seq }, "chat index write failed; catch-up will retry");
    }
  }

  /** Indexes up to `batch` chat rows the index hasn't seen: live rows above the stored high-water seq,
   *  then imported rows below the stored low-water seq. Returns true while more remain. */
  catchUp(batch = 1000): boolean {
    try {
      return this.db.transaction(() => {
        const high = this.kv(HIGH_KEY) ?? 0;
        const up = this.db
          .query(`SELECT seq, data FROM web_events WHERE seq > ? AND type IN (${CHAT_TYPES_SQL}) ORDER BY seq LIMIT ?`)
          .all(high, batch) as { seq: number; data: string }[];
        this.index(up);
        if (up.length) this.setKv(HIGH_KEY, up[up.length - 1]!.seq);
        const low = this.kv(LOW_KEY) ?? 1;
        const down = this.db
          .query(`SELECT seq, data FROM web_events WHERE seq < ? AND seq <= 0 AND type IN (${CHAT_TYPES_SQL}) ORDER BY seq DESC LIMIT ?`)
          .all(low, batch) as { seq: number; data: string }[];
        this.index(down);
        if (down.length) this.setKv(LOW_KEY, down[down.length - 1]!.seq);
        return up.length === batch || down.length === batch;
      })();
    } catch (err) {
      log.warn({ err }, "chat index catch-up failed");
      return false;
    }
  }

  private index(rows: { seq: number; data: string }[]): void {
    const insert = this.db.query("INSERT OR REPLACE INTO web_chat_fts (rowid, text) VALUES (?, ?)");
    for (const r of rows) {
      const text = (JSON.parse(r.data) as { text?: unknown }).text;
      insert.run(r.seq, typeof text === "string" ? text : "");
    }
  }

  private kv(key: string): number | null {
    const row = this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
    const n = row ? Number(row.value) : NaN;
    return Number.isSafeInteger(n) ? n : null;
  }

  private setKv(key: string, value: number): void {
    this.db.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  }
}

/** The query's words. Only letters, digits and marks survive, so nothing the owner types can reach FTS5 as syntax. */
export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const m of query.normalize("NFC").matchAll(WORD)) {
    seen.add(m[0].toLowerCase());
    if (seen.size >= QUERY_TOKENS_MAX) break;
  }
  return [...seen];
}

/** An FTS5 MATCH expression: every token as a quoted phrase, implicitly ANDed. A one-letter token matches
 *  exactly, since a one-letter prefix expands to most of the index. null: nothing to match. */
export function ftsQuery(tokens: readonly string[]): string | null {
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"${[...t].length > 1 ? "*" : ""}`).join(" ");
}

type Row = { seq: number; type: (typeof CHAT_INDEX_TYPES)[number]; data: string; created_at: number };

/**
 * The newest chat messages matching every word of `query`, newest first (by seq, which follows time for
 * live and imported rows alike), at most `limit`. `more` is true when older matches were left out.
 * Throws when the index is missing or broken.
 */
export function searchChat(db: Database, query: string, limit: number): { hits: ChatHit[]; more: boolean } {
  const tokens = queryTokens(query);
  const match = ftsQuery(tokens);
  if (!match) return { hits: [], more: false };
  const want = limit + 1;
  const rows: Row[] = [];
  let below: number | null = null;
  for (let round = 0; round < FETCH_ROUNDS && rows.length < want; round++) {
    const ids = (
      below === null
        ? db.query("SELECT rowid AS id FROM web_chat_fts WHERE web_chat_fts MATCH ? ORDER BY rowid DESC LIMIT ?").all(match, want)
        : db.query("SELECT rowid AS id FROM web_chat_fts WHERE web_chat_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?").all(match, below, want)
    ) as { id: number }[];
    if (!ids.length) break;
    below = ids[ids.length - 1]!.id;
    const found = db
      .query(`SELECT seq, type, data, created_at FROM web_events WHERE seq IN (${ids.map(() => "?").join(",")}) AND type IN (${CHAT_TYPES_SQL}) ORDER BY seq DESC`)
      .all(...ids.map((r) => r.id)) as Row[];
    rows.push(...found);
    if (ids.length < want) break;
  }
  const hits = rows.slice(0, limit).map((r) => toHit(r, tokens));
  return { hits, more: rows.length > limit };
}

function toHit(r: Row, tokens: readonly string[]): ChatHit {
  const at = new Date(r.created_at).toISOString();
  if (r.type === "user") {
    const d = JSON.parse(r.data) as ChatEventMap["user"];
    return { source: "chat", id: String(r.seq), at: d.at, role: "user", ...snippet(d.text, tokens) };
  }
  const d = JSON.parse(r.data) as ChatEventMap["reply" | "alert"];
  return { source: "chat", id: String(r.seq), at, role: "agent", ...snippet(d.text, tokens) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Diacritics stripped the way the index folds them. */
function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/** `cps` folded, with each folded UTF-16 unit's source code-point index. */
function foldWithMap(cps: readonly string[]): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  cps.forEach((cp, i) => {
    const f = foldText(cp);
    for (let k = 0; k < f.length; k++) from.push(i);
    folded += f;
  });
  return { folded, from };
}

/** Matches of `re` in `cps` as code-point ranges, matched on the folded text. */
function foldedMatches(cps: readonly string[], re: RegExp, max: number): SearchRange[] {
  const { folded, from } = foldWithMap(cps);
  const out: SearchRange[] = [];
  re.lastIndex = 0;
  for (const m of folded.matchAll(re)) {
    if (out.length >= max || !m[0].length) break;
    const start = from[m.index]!;
    let end = from[m.index + m[0].length - 1]! + 1;
    // A trailing combining mark folded away still belongs to the matched letter.
    while (end < cps.length && foldText(cps[end]!) === "") end++;
    if (end > start) out.push([start, end]);
  }
  return out;
}

/** One line of at most SNIPPET_MAX code points around the first match, with the matches as code-point ranges. */
export function snippet(text: string, tokens: readonly string[]): { snippet: string; ranges: SearchRange[] } {
  const line = [...text.replace(/\s+/g, " ").trim()];
  const folded = [...new Set(tokens.map((t) => foldText(t).toLowerCase()).filter((t) => t.length))];
  // Longest first, so "foobar" wins over "foo" at the same place.
  const re = folded.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${folded.sort((a, b) => b.length - a.length).map((t) => escapeRegExp(t) + ([...t].length > 1 ? "" : "(?![\\p{L}\\p{N}])")).join("|")})`, "giu") : null;
  let start = 0;
  if (re && line.length > SNIPPET_MAX) {
    const first = foldedMatches(line, re, 1)[0];
    if (first) start = Math.max(0, Math.min(first[0] - LEAD, line.length - SNIPPET_MAX));
  }
  const cut = line.slice(start, start + SNIPPET_MAX);
  return { snippet: cut.join(""), ranges: re ? foldedMatches(cut, re, RANGES_MAX) : [] };
}
