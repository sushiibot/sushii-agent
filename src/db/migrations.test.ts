import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { applySchema } from "./index.ts";
import * as schema from "./schema.ts";

const realMigrationsDir = join(import.meta.dir, "..", "..", "drizzle");
const WEB_TABLES = ["web_events", "web_inbound", "web_uploads"];

type Journal = { entries: { idx: number; when: number; tag: string }[] };

function readJournal(dir: string): Journal {
  return JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as Journal;
}

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

describe("drizzle migrations", () => {
  // The bun-sqlite migrator skips any migration whose `when` is not after the last applied one.
  test("journal entries are numbered in order with strictly increasing timestamps", () => {
    const { entries } = readJournal(realMigrationsDir);
    entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(e.tag.startsWith(String(i).padStart(4, "0") + "_")).toBe(true);
      if (i > 0) expect(e.when).toBeGreaterThan(entries[i - 1]!.when);
    });
  });

  test("a fresh database gets every web table", () => {
    const db = new Database(":memory:");
    try {
      applySchema(db);
      expect(tables(db)).toEqual(expect.arrayContaining(WEB_TABLES));
    } finally {
      db.close();
    }
  });

  test("a database at the 0012 schema upgrades to every web table", () => {
    const scratch = mkdtempSync(join(tmpdir(), "migrations-pre0013-"));
    cpSync(realMigrationsDir, scratch, { recursive: true });
    const journal = readJournal(scratch);
    journal.entries = journal.entries.filter((e) => e.idx <= 12);
    writeFileSync(join(scratch, "meta", "_journal.json"), JSON.stringify(journal));

    const db = new Database(":memory:");
    try {
      migrate(drizzle({ client: db, schema }), { migrationsFolder: scratch });
      for (const t of WEB_TABLES) expect(tables(db)).not.toContain(t);

      applySchema(db);
      expect(tables(db)).toEqual(expect.arrayContaining(WEB_TABLES));
    } finally {
      db.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("0015 gives web_inbound rows a state: routed where a receipt came, pending otherwise", () => {
    const scratch = mkdtempSync(join(tmpdir(), "migrations-pre0015-"));
    cpSync(realMigrationsDir, scratch, { recursive: true });
    const journal = readJournal(scratch);
    journal.entries = journal.entries.filter((e) => e.idx <= 14);
    writeFileSync(join(scratch, "meta", "_journal.json"), JSON.stringify(journal));

    const db = new Database(":memory:");
    try {
      migrate(drizzle({ client: db, schema }), { migrationsFolder: scratch });
      db.run("INSERT INTO web_inbound (client_id, text, upload_ids, seq, created_at, routed_at) VALUES ('a', 't', '[]', 1, 1, 5), ('b', 't', '[]', 2, 2, NULL)");
      applySchema(db);
      expect(db.query("SELECT client_id, state FROM web_inbound ORDER BY client_id").all()).toEqual([
        { client_id: "a", state: "routed" },
        { client_id: "b", state: "pending" },
      ]);
    } finally {
      db.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
