import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { applySchema } from "../../db/index.ts";
import * as schema from "../../db/schema.ts";
import { SqliteChatLog } from "./chatLog.ts";
import { QUERY_TOKENS_MAX, RANGES_MAX, SNIPPET_MAX, ftsQuery, queryTokens, searchChat, snippet } from "./chatSearch.ts";
import { historyPage } from "./history.ts";

const T0 = Date.parse("2026-09-30T10:00:00.000Z");

function setup() {
  const db = new Database(":memory:");
  applySchema(db);
  let t = T0;
  const log = new SqliteChatLog(db, { now: () => (t += 1000) });
  return { db, log };
}

const user = (key: string, text: string) => ({ key, text, uploadIds: [], at: "2026-09-30T09:00:00.000Z" });
const reply = (key: string, text: string) => ({ key, text, files: [] });
const ids = (db: Database, q: string) => searchChat(db, q, 20).hits.map((h) => h.id);
const integrity = (db: Database) => db.run("INSERT INTO web_chat_fts(web_chat_fts) VALUES ('integrity-check')");

describe("chat FTS sync", () => {
  test("user, reply and proactive rows are indexed on insert; other events are not", () => {
    const { db, log } = setup();
    const u = log.append("user", user("u1", "the zebra crossing"), "u1");
    const r = log.append("reply", reply("r1", "a zebra answer"), "r1");
    const p = log.append("proactive", reply("p1", "zebra alert"), "p1");
    log.append("notice", { type: "commandResult", text: "zebra notice" });
    log.append("ask", { key: "a1", askId: "a1", question: "zebra ask?", choices: [] }, "a1");
    expect(ids(db, "zebra").sort()).toEqual([u, r, p].map(String).sort());
    integrity(db);
  });

  test("imported rows with negative seqs are indexed and keep their history ids", () => {
    const { db, log } = setup();
    log.append("user", user("live", "live okapi"), "live");
    log.prepend([
      { type: "reply", key: "pi:2", data: reply("pi:2", "imported okapi answer"), createdAt: T0 - 50_000 },
      { type: "user", key: "pi:1", data: user("pi:1", "imported okapi question"), createdAt: T0 - 60_000 },
    ]);
    const hits = searchChat(db, "imported okapi", 20).hits;
    expect(hits.map((h) => [h.id, h.role])).toEqual([
      ["0", "agent"],
      ["-1", "user"],
    ]);
    const historyIds = historyPage(log, { limit: 10 }, { maxBytes: 1 << 20 }).items.map((i) => i.id);
    for (const h of hits) expect(historyIds).toContain(h.id);
    integrity(db);
  });

  test("a delete the keep-chat trigger ignores leaves the index alone; a real delete removes the row", () => {
    const { db, log } = setup();
    const seq = log.append("user", user("u1", "persistent narwhal"), "u1");
    const gone = log.append("notice", { type: "commandResult", text: "narwhal" });
    log.prune(T0 + 365 * 86_400_000);
    db.run("DELETE FROM web_events");
    expect(db.query("SELECT seq FROM web_events").all()).toEqual([{ seq }]);
    expect(ids(db, "narwhal")).toEqual([String(seq)]);
    expect(gone).toBeGreaterThan(seq);
    integrity(db);

    db.run("DROP TRIGGER web_events_keep_chat");
    db.run("DELETE FROM web_events WHERE seq = ?", [seq]);
    expect(ids(db, "narwhal")).toEqual([]);
    integrity(db);
  });

  test("an update re-indexes the row", () => {
    const { db, log } = setup();
    const seq = log.append("reply", reply("r1", "old walrus"), "r1");
    db.run("UPDATE web_events SET data = ? WHERE seq = ?", [JSON.stringify(reply("r1", "new manatee")), seq]);
    expect(ids(db, "walrus")).toEqual([]);
    expect(ids(db, "manatee")).toEqual([String(seq)]);
    integrity(db);
  });

  test("the migration backfills rows written before it, imported ones included", () => {
    const real = join(import.meta.dir, "..", "..", "..", "drizzle");
    const scratch = mkdtempSync(join(tmpdir(), "migrations-pre0018-"));
    try {
      cpSync(real, scratch, { recursive: true });
      const journalPath = join(scratch, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
      journal.entries = journal.entries.filter((e) => e.idx <= 17);
      writeFileSync(journalPath, JSON.stringify(journal));
      const db = new Database(":memory:");
      migrate(drizzle({ client: db, schema }), { migrationsFolder: scratch });
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'web_chat_fts'").all()).toEqual([]);
      const log = new SqliteChatLog(db, { now: () => T0 });
      const u = log.append("user", user("u1", "early axolotl"), "u1");
      log.append("notice", { type: "commandResult", text: "axolotl notice" });
      log.prepend([{ type: "reply", key: "pi:1", data: reply("pi:1", "imported axolotl"), createdAt: T0 - 1000 }]);

      applySchema(db);
      expect(ids(db, "axolotl").sort()).toEqual([String(u), "0"].sort());
      integrity(db);
      log.append("reply", reply("r2", "later axolotl"), "r2");
      expect(ids(db, "axolotl")).toHaveLength(3);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("chat search queries", () => {
  test("results are newest first and capped, with `more` when older matches exist", () => {
    const { db, log } = setup();
    const seqs = Array.from({ length: 5 }, (_, i) => log.append("reply", reply(`r${i}`, `gecko ${i}`), `r${i}`));
    const res = searchChat(db, "gecko", 3);
    expect(res.hits.map((h) => h.id)).toEqual(seqs.slice(2).reverse().map(String));
    expect(res.more).toBe(true);
    expect(searchChat(db, "gecko", 5).more).toBe(false);
  });

  test("every word must match, as a word prefix", () => {
    const { db, log } = setup();
    const both = log.append("user", user("a", "red panda"), "a");
    log.append("user", user("b", "red fox"), "b");
    expect(ids(db, "pan red")).toEqual([String(both)]);
    expect(ids(db, "anda")).toEqual([]);
  });

  test("FTS5 syntax in a query is matched literally, never as operators", () => {
    const { db, log } = setup();
    const onlyB = log.append("user", user("b", "bravo"), "b");
    const withOr = log.append("user", user("c", "alpha or bravo"), "c");
    const near = log.append("user", user("d", "near alpha bravo"), "d");
    // `alpha OR bravo` as an operator would also match "bravo" alone.
    expect(ids(db, "alpha OR bravo")).toEqual([String(withOr)]);
    expect(ids(db, "NEAR(alpha bravo)").sort()).toEqual([String(near)]);
    expect(ids(db, "bravo NOT alpha")).toEqual([]);
    expect(ids(db, "text:bravo")).toEqual([]);
    expect(ids(db, "bravo*").sort()).toEqual([onlyB, withOr, near].map(String).sort());
    for (const q of ['" OR "', "a AND b", "*", "^x", "-x", "(", '"unbalanced', "'; DROP TABLE web_events; --", "!!", "\0\0", "😀".repeat(200), "{x y}:z", "x + y"]) {
      expect(() => searchChat(db, q, 20)).not.toThrow();
    }
    expect(db.query("SELECT count(*) AS n FROM web_events").get()).toEqual({ n: 3 });
  });

  test("a query of punctuation only matches nothing without touching FTS", () => {
    expect(queryTokens("!! -- ()")).toEqual([]);
    expect(ftsQuery([])).toBeNull();
    const { db } = setup();
    expect(searchChat(db, '"*"', 20)).toEqual({ hits: [], more: false });
  });

  test("tokens are capped and quoted", () => {
    expect(queryTokens("A a b")).toEqual(["a", "b"]);
    expect(queryTokens(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "))).toHaveLength(QUERY_TOKENS_MAX);
    expect(ftsQuery(["ab", "c"])).toBe('"ab"* "c"*');
  });

  test("a user hit carries its message time; an agent hit its stored time", () => {
    const { db, log } = setup();
    log.append("user", user("u", "ibis"), "u");
    log.append("proactive", reply("p", "ibis"), "p");
    const [p, u] = searchChat(db, "ibis", 20).hits;
    expect(u).toMatchObject({ source: "chat", role: "user", at: "2026-09-30T09:00:00.000Z" });
    expect(p).toMatchObject({ source: "chat", role: "agent", at: new Date(T0 + 2000).toISOString() });
  });
});

describe("snippet", () => {
  test("one line around the first match, in code points, with ranges on the snippet", () => {
    const text = `${"x".repeat(300)}\n\n🦊 Needle here and needles there ${"y".repeat(300)}`;
    const s = snippet(text, ["needle"]);
    expect([...s.snippet]).toHaveLength(SNIPPET_MAX);
    expect(s.snippet).not.toContain("\n");
    const cps = [...s.snippet];
    expect(s.ranges.length).toBe(2);
    for (const [a, b] of s.ranges) expect(cps.slice(a, b).join("").toLowerCase()).toBe("needle");
    expect(cps.slice(s.ranges[0]![0] - 2, s.ranges[0]![0]).join("")).toBe("🦊 ");
  });

  test("ranges are non-empty, capped, and only at word starts", () => {
    const s = snippet("cat cat cat cat cat cat cat concat", ["cat"]);
    expect(s.ranges).toHaveLength(RANGES_MAX);
    for (const [a, b] of s.ranges) expect(b).toBeGreaterThan(a);
    expect(snippet("concat", ["cat"]).ranges).toEqual([]);
  });

  test("HTML in the text stays plain text in the snippet", () => {
    const s = snippet('<b>bold</b> <img src=x onerror=alert(1)>', ["bold"]);
    expect(s.snippet).toBe('<b>bold</b> <img src=x onerror=alert(1)>');
    expect(s.ranges).toEqual([[3, 7]]);
  });

  test("text with no visible match starts at the beginning with no ranges", () => {
    expect(snippet("café au lait", ["cafe"])).toEqual({ snippet: "café au lait", ranges: [] });
  });
});
