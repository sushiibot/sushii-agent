import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { SessionStore } from "./session.ts";

const identity = { id: "u1", username: "alice", avatar: null };

function testDb(): Database {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    for (const sql of migration) db.exec(sql);
  }
  return db;
}

describe("SessionStore", () => {
  test("mints a token distinct from any upstream token and resolves it back to the session", () => {
    const store = new SessionStore();
    const discordToken = "discord-access-token-not-ours";
    const token = store.mint({ identity, permittedGuildIds: ["a"] });

    expect(token).not.toBe(discordToken);
    expect(store.verify(token)).toEqual({ identity, permittedGuildIds: ["a"] });
  });

  test("rejects a token that isn't in the session map at all", () => {
    const store = new SessionStore();
    expect(store.verify("discord-access-token-not-ours")).toBeNull();
  });

  test("rejects a token past its TTL", () => {
    const store = new SessionStore(-1); // already-expired TTL
    const token = store.mint({ identity, permittedGuildIds: ["a"] });
    expect(store.verify(token)).toBeNull();
  });

  test("a user whitelisted in multiple guilds gets a session covering all of them", () => {
    const store = new SessionStore();
    const token = store.mint({ identity, permittedGuildIds: ["a", "b"] });
    expect(store.verify(token)?.permittedGuildIds.sort()).toEqual(["a", "b"]);
  });

  test("revoke invalidates a previously valid token", () => {
    const store = new SessionStore();
    const token = store.mint({ identity, permittedGuildIds: ["a"] });
    store.revoke(token);
    expect(store.verify(token)).toBeNull();
  });

  describe("with a Database", () => {
    test("a token minted before a restart is still valid after rehydrating from the DB", () => {
      const db = testDb();
      const before = new SessionStore(undefined, db);
      const token = before.mint({ identity, permittedGuildIds: ["a"] });

      const after = new SessionStore(undefined, db);
      expect(after.verify(token)).toEqual({ identity, permittedGuildIds: ["a"] });
    });

    test("revoke removes the token from the DB too, not just memory", () => {
      const db = testDb();
      const before = new SessionStore(undefined, db);
      const token = before.mint({ identity, permittedGuildIds: ["a"] });
      before.revoke(token);

      const after = new SessionStore(undefined, db);
      expect(after.verify(token)).toBeNull();
    });

    test("an expired token isn't rehydrated on restart", () => {
      const db = testDb();
      const before = new SessionStore(-1, db); // already-expired TTL
      const token = before.mint({ identity, permittedGuildIds: ["a"] });

      const after = new SessionStore(undefined, db);
      expect(after.verify(token)).toBeNull();
    });
  });
});
