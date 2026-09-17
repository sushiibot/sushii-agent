import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applySchema } from "./index.ts";
import { getBuzzCursor, setBuzzCursor } from "./buzzState.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("buzz cursor persistence", () => {
  test("defaults to 0 for an unseen relay key", () => {
    expect(getBuzzCursor(testDb(), "wss://a")).toBe(0);
  });

  test("round-trips and upserts a cursor for one key", () => {
    const db = testDb();
    setBuzzCursor(db, "wss://a", 1000);
    expect(getBuzzCursor(db, "wss://a")).toBe(1000);
    setBuzzCursor(db, "wss://a", 2000);
    expect(getBuzzCursor(db, "wss://a")).toBe(2000);
  });

  test("keeps each relay's cursor independent (no cross-community bleed)", () => {
    const db = testDb();
    setBuzzCursor(db, "wss://a", 1000);
    setBuzzCursor(db, "wss://b", 5000);
    expect(getBuzzCursor(db, "wss://a")).toBe(1000);
    expect(getBuzzCursor(db, "wss://b")).toBe(5000);
  });
});
