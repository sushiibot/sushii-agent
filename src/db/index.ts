import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { MIGRATIONS } from "./schema.ts";

let _db: Database;

export function getDb(): Database {
  return _db;
}

export async function initDb(): Promise<Database> {
  await mkdir(dirname(config.databasePath), { recursive: true });

  _db = new Database(config.databasePath);

  // WAL mode for better concurrent read performance
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA synchronous = NORMAL");

  runMigrations(_db);

  return _db;
}

export function closeDb(): void {
  _db?.close();
}

function runMigrations(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = row.user_version;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    console.log(`Running migration ${i}...`);
    for (const sql of MIGRATIONS[i]) {
      db.exec(sql);
    }
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
}
