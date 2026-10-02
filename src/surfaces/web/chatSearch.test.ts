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
import { ChatIndex, QUERY_TOKENS_MAX, RANGES_MAX, SNIPPET_MAX, ftsQuery, queryTokens, searchChat, snippet } from "./chatSearch.ts";
import { historyPage } from "./history.ts";

const T0 = Date.parse("2026-09-30T10:00:00.000Z");

function setup(db = new Database(":memory:"), migrated = false) {
  if (!migrated) applySchema(db);
  let t = T0;
  const index = new ChatIndex(db);
  const log = new SqliteChatLog(db, { now: () => (t += 1000), index });
  return { db, log, index };
}

const user = (key: string, text: string) => ({ key, text, uploadIds: [], at: "2026-09-30T09:00:00.000Z" });
const reply = (key: string, text: string) => ({ key, text, files: [] });
const ids = (db: Database, q: string) => searchChat(db, q, 20).hits.map((h) => h.id);
const integrity = (db: Database) => db.run("INSERT INTO web_chat_fts(web_chat_fts) VALUES ('integrity-check')");
const drain = (index: ChatIndex) => {
  while (index.catchUp(2)) {}
};

describe("chat index sync", () => {
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

  test("a job alert is indexed by its text and returned as an agent message", () => {
    const { db, log, index } = setup();
    const alert = { source: "job" as const, job: "nightly", kind: "failed" as const, trigger: "daily" as const, startedAt: "2026-09-30T03:00:00Z", schedule: "daily 03:00" };
    const seq = log.append("alert", { key: "o1", alert, text: "Scheduled job nightly failed: disk full" }, "o1");
    expect(searchChat(db, "nightly disk", 20).hits).toEqual([
      { source: "chat", id: String(seq), at: new Date(T0 + 1000).toISOString(), role: "agent", snippet: "Scheduled job nightly failed: disk full", ranges: [[14, 21], [30, 34]] },
    ]);
    db.run("DELETE FROM web_chat_fts");
    drain(index);
    expect(ids(db, "nightly")).toEqual([String(seq)]);
  });

  test("a missing or broken index never fails a chat write, and search then throws", () => {
    const { db, log, index } = setup();
    db.run("DROP TABLE web_chat_fts");
    const seq = log.append("user", user("u1", "still stored"), "u1");
    expect(log.find("user", "u1")?.seq).toBe(seq);
    log.transaction(() => log.append("reply", reply("r1", "also stored"), "r1"));
    expect(log.find("reply", "r1")).not.toBeNull();
    expect(index.catchUp()).toBe(false);
    expect(() => searchChat(db, "stored", 20)).toThrow();
  });

  test("catch-up indexes rows the live write missed, and imported rows below every live one", () => {
    const { db, log, index } = setup();
    const live = log.append("user", user("live", "live okapi"), "live");
    db.run("INSERT INTO web_events (type, key, data, created_at) VALUES ('reply', 'missed', ?, ?)", [JSON.stringify(reply("missed", "missed okapi")), T0 + 5000]);
    log.prepend([
      { type: "reply", key: "pi:2", data: reply("pi:2", "imported okapi answer"), createdAt: T0 - 50_000 },
      { type: "user", key: "pi:1", data: user("pi:1", "imported okapi question"), createdAt: T0 - 60_000 },
    ]);
    expect(ids(db, "okapi")).toEqual([String(live)]);
    drain(index);
    expect(ids(db, "okapi")).toEqual(["2", String(live), "0", "-1"]);
    // A later import lands below the low-water mark and is picked up too; nothing is indexed twice.
    log.prepend([{ type: "user", key: "pi:0", data: user("pi:0", "older okapi"), createdAt: T0 - 70_000 }]);
    drain(index);
    expect(ids(db, "okapi")).toEqual(["2", String(live), "0", "-1", "-2"]);
    expect(index.catchUp()).toBe(false);
    integrity(db);

    const historyIds = historyPage(log, { limit: 10 }, { maxBytes: 1 << 20 }).items.map((i) => i.id);
    for (const id of ids(db, "okapi")) expect(historyIds).toContain(id);
  });

  test("indexing a row twice keeps one entry", () => {
    const { db, log, index } = setup();
    const seq = log.append("reply", reply("r1", "single walrus"), "r1");
    index.add(seq, "single walrus");
    drain(index);
    expect(ids(db, "walrus")).toEqual([String(seq)]);
    integrity(db);
  });

  test("chat rows survive prune and deletes, so their entries stay; a row erased anyway drops out of results", () => {
    const { db, log } = setup();
    const older = log.append("user", user("u0", "persistent narwhal"), "u0");
    const seq = log.append("user", user("u1", "persistent narwhal"), "u1");
    log.append("notice", { type: "commandResult", text: "narwhal" });
    log.prune(T0 + 365 * 86_400_000);
    db.run("DELETE FROM web_events");
    expect(ids(db, "narwhal")).toEqual([String(seq), String(older)]);

    db.run("DROP TRIGGER web_events_keep_chat");
    db.run("DELETE FROM web_events WHERE seq = ?", [seq]);
    expect(searchChat(db, "narwhal", 1)).toMatchObject({ hits: [{ id: String(older) }], more: false });
  });

  test("a database migrated before the index gets every chat row on catch-up", () => {
    const real = join(import.meta.dir, "..", "..", "..", "drizzle");
    const scratch = mkdtempSync(join(tmpdir(), "migrations-pre-chat-fts-"));
    try {
      cpSync(real, scratch, { recursive: true });
      const journalPath = join(scratch, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
      // Everything from 0019 on: drizzle applies only migrations newer than the last one applied.
      journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === "0019_web_chat_search"));
      writeFileSync(journalPath, JSON.stringify(journal));
      const db = new Database(":memory:");
      migrate(drizzle({ client: db, schema }), { migrationsFolder: scratch });
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'web_chat_fts'").all()).toEqual([]);
      // Seed the old schema directly; the current log requires the conversation migration.
      const u = db.query("INSERT INTO web_events (type, key, data, created_at) VALUES ('user', 'u1', ?, ?) RETURNING seq").get(JSON.stringify(user("u1", "early axolotl")), T0) as { seq: number };
      db.run("INSERT INTO web_events (seq, type, key, data, created_at) VALUES (0, 'reply', 'pi:1', ?, ?)", [JSON.stringify(reply("pi:1", "imported axolotl")), T0 - 1000]);

      applySchema(db);
      const { log, index } = setup(db, true);
      drain(index);
      expect(ids(db, "axolotl")).toEqual([String(u.seq), "0"]);
      integrity(db);
      log.append("reply", reply("r2", "later axolotl"), "r2");
      expect(ids(db, "axolotl")).toHaveLength(3);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a broad search over 100k rows reads the index newest first instead of sorting every match", () => {
    const db = new Database(":memory:");
    applySchema(db);
    const words = ["the", "a", "to", "and", "of", "in", "is", "it", "that", "was", "for", "on", "with", "as", "be", "at", "by", "this", "had", "not"];
    const insert = db.query("INSERT INTO web_events (type, key, data, created_at) VALUES ('reply', ?, ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 100_000; i++) {
        const text = Array.from({ length: 40 }, (_, k) => words[(i * 7 + k * 13) % words.length]).join(" ");
        insert.run(`k${i}`, JSON.stringify(reply(`k${i}`, text)), T0 + i);
      }
    })();
    const index = new ChatIndex(db);
    while (index.catchUp(20_000)) {}
    const plan = db.query("EXPLAIN QUERY PLAN SELECT rowid FROM web_chat_fts WHERE web_chat_fts MATCH ? ORDER BY rowid DESC LIMIT 21").all('"the"*') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).not.toContain("TEMP B-TREE");
    const started = performance.now();
    const res = searchChat(db, "the a to and of in is it", 20);
    const ms = performance.now() - started;
    expect(res.hits).toHaveLength(20);
    expect(res.hits[0]!.id).toBe("100000");
    expect(ms).toBeLessThan(400);
  }, 60_000);
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
    expect(ftsQuery(["ab", "c"])).toBe('"ab"* "c"');
  });

  test("a one-letter word matches exactly, not as a prefix", () => {
    const { db, log } = setup();
    const exact = log.append("user", user("a", "plan b ready"), "a");
    log.append("user", user("b", "plan bravo"), "b");
    expect(ids(db, "plan b")).toEqual([String(exact)]);
  });

  test("a word with combining marks stays one word, so it can't match its letters scattered", () => {
    expect(queryTokens("हिंदी")).toEqual(["हिंदी"]);
    const { db, log } = setup();
    const hit = log.append("user", user("a", "मुझे हिंदी पसंद है"), "a");
    log.append("user", user("b", "हम दो"), "b");
    expect(ids(db, "हिंदी")).toEqual([String(hit)]);
  });

  test("a decomposed query finds composed text, accents folded", () => {
    const { db, log } = setup();
    const seq = log.append("user", user("u", "Crème brûlée"), "u");
    expect(ids(db, "cre\u0300me")).toEqual([String(seq)]);
    expect(ids(db, "brulee")).toEqual([String(seq)]);
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

  test("matching folds diacritics the way the index does, both ways", () => {
    expect(snippet("café au lait", ["cafe"])).toEqual({ snippet: "café au lait", ranges: [[0, 4]] });
    expect(snippet("un cafe noir", ["café"]).ranges).toEqual([[3, 7]]);
    // Stored decomposed: the range covers the trailing combining mark.
    const nfd = "la cre\u0300me";
    expect(snippet(nfd, ["crème"]).ranges).toEqual([[3, 9]]);
  });

  test("the window centres on a match found only after folding", () => {
    const s = snippet(`${"x ".repeat(150)}the café closes`, ["cafe"]);
    expect(s.snippet).toContain("café");
    const [a, b] = s.ranges[0]!;
    expect([...s.snippet].slice(a, b).join("")).toBe("café");
  });

  test("a one-letter token highlights only the whole word", () => {
    expect(snippet("b bravo b", ["b"]).ranges).toEqual([
      [0, 1],
      [8, 9],
    ]);
  });

  test("text with no match starts at the beginning with no ranges", () => {
    expect(snippet("au lait", ["cafe"])).toEqual({ snippet: "au lait", ranges: [] });
  });
});
