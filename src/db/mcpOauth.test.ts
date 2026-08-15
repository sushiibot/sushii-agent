import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "./schema.ts";
import {
  deleteExpiredOAuthClients,
  deleteExpiredOAuthSessions,
  deleteOAuthSession,
  loadOAuthClients,
  loadOAuthSessions,
  saveOAuthClient,
  saveOAuthSession,
} from "./mcpOauth.ts";

function testDb(): Database {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    for (const sql of migration) db.exec(sql);
  }
  return db;
}

describe("OAuth client persistence", () => {
  test("round-trips a saved client", () => {
    const db = testDb();
    const client = { clientId: "c1", redirectUris: ["https://example.com/cb"] };
    saveOAuthClient(db, client, Date.now() + 60_000);
    expect(loadOAuthClients(db, Date.now())).toEqual([{ key: "c1", value: client, expiresAt: expect.any(Number) }]);
  });

  test("excludes expired clients from load", () => {
    const db = testDb();
    saveOAuthClient(db, { clientId: "c1", redirectUris: ["https://example.com/cb"] }, Date.now() - 1000);
    expect(loadOAuthClients(db, Date.now())).toEqual([]);
  });

  test("deleteExpiredOAuthClients removes only expired rows", () => {
    const db = testDb();
    saveOAuthClient(db, { clientId: "expired", redirectUris: [] }, Date.now() - 1000);
    saveOAuthClient(db, { clientId: "live", redirectUris: [] }, Date.now() + 60_000);
    deleteExpiredOAuthClients(db, Date.now());
    const row = db.query("SELECT client_id FROM mcp_oauth_clients").all() as { client_id: string }[];
    expect(row.map((r) => r.client_id)).toEqual(["live"]);
  });
});

describe("OAuth session persistence", () => {
  const session = { identity: { id: "u1", username: "alice", avatar: null }, permittedGuildIds: ["guildA"] };

  test("round-trips a saved session", () => {
    const db = testDb();
    saveOAuthSession(db, "tok1", session, Date.now() + 60_000);
    expect(loadOAuthSessions(db, Date.now())).toEqual([{ key: "tok1", value: session, expiresAt: expect.any(Number) }]);
  });

  test("excludes expired sessions from load", () => {
    const db = testDb();
    saveOAuthSession(db, "tok1", session, Date.now() - 1000);
    expect(loadOAuthSessions(db, Date.now())).toEqual([]);
  });

  test("deleteOAuthSession removes only that token", () => {
    const db = testDb();
    saveOAuthSession(db, "tok1", session, Date.now() + 60_000);
    saveOAuthSession(db, "tok2", session, Date.now() + 60_000);
    deleteOAuthSession(db, "tok1");
    const rows = db.query("SELECT token FROM mcp_oauth_sessions").all() as { token: string }[];
    expect(rows.map((r) => r.token)).toEqual(["tok2"]);
  });

  test("deleteExpiredOAuthSessions removes only expired rows", () => {
    const db = testDb();
    saveOAuthSession(db, "expired", session, Date.now() - 1000);
    saveOAuthSession(db, "live", session, Date.now() + 60_000);
    deleteExpiredOAuthSessions(db, Date.now());
    const rows = db.query("SELECT token FROM mcp_oauth_sessions").all() as { token: string }[];
    expect(rows.map((r) => r.token)).toEqual(["live"]);
  });
});
