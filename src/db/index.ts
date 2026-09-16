import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

let _db: Database;
let _orm: BunSQLiteDatabase<typeof schema>;

export function getDb(): Database {
  return _db;
}

export function getOrm(): BunSQLiteDatabase<typeof schema> {
  return _orm;
}

export async function initDb(): Promise<Database> {
  await mkdir(dirname(config.databasePath), { recursive: true });

  _db = new Database(config.databasePath);
  applyPragmas(_db);
  _orm = drizzle({ client: _db, schema });
  migrate(_orm, { migrationsFolder: "drizzle" });

  return _db;
}

export function closeDb(): void {
  _db?.close();
}

function applyPragmas(db: Database): void {
  // WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
}

/** Builds a schema on the given connection via the same migrator prod uses — for tests. */
export function applySchema(db: Database): BunSQLiteDatabase<typeof schema> {
  const orm = drizzle({ client: db, schema });
  migrate(orm, { migrationsFolder: "drizzle" });
  return orm;
}
