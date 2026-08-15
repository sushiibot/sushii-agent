import type { Database } from "bun:sqlite";
import type { RegisteredClient } from "../mcp/server/oauthServer.ts";
import type { DiscordIdentity, McpSession } from "../mcp/server/session.ts";

export interface StoredEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
}

interface ClientRow {
  client_id: string;
  redirect_uris: string;
  expires_at: number;
}

export function loadOAuthClients(db: Database, now: number): StoredEntry<RegisteredClient>[] {
  const rows = db
    .query("SELECT client_id, redirect_uris, expires_at FROM mcp_oauth_clients WHERE expires_at > ?")
    .all(now) as ClientRow[];
  return rows.map((row) => ({
    key: row.client_id,
    value: { clientId: row.client_id, redirectUris: JSON.parse(row.redirect_uris) },
    expiresAt: row.expires_at,
  }));
}

export function saveOAuthClient(db: Database, client: RegisteredClient, expiresAt: number): void {
  db.query("INSERT OR REPLACE INTO mcp_oauth_clients (client_id, redirect_uris, expires_at) VALUES (?, ?, ?)").run(
    client.clientId,
    JSON.stringify(client.redirectUris),
    expiresAt,
  );
}

export function deleteExpiredOAuthClients(db: Database, now: number): void {
  db.query("DELETE FROM mcp_oauth_clients WHERE expires_at <= ?").run(now);
}

interface SessionRow {
  token: string;
  identity: string;
  permitted_guild_ids: string;
  expires_at: number;
}

export function loadOAuthSessions(db: Database, now: number): StoredEntry<McpSession>[] {
  const rows = db
    .query("SELECT token, identity, permitted_guild_ids, expires_at FROM mcp_oauth_sessions WHERE expires_at > ?")
    .all(now) as SessionRow[];
  return rows.map((row) => ({
    key: row.token,
    value: {
      identity: JSON.parse(row.identity) as DiscordIdentity,
      permittedGuildIds: JSON.parse(row.permitted_guild_ids),
    },
    expiresAt: row.expires_at,
  }));
}

export function saveOAuthSession(db: Database, token: string, session: McpSession, expiresAt: number): void {
  db.query(
    "INSERT OR REPLACE INTO mcp_oauth_sessions (token, identity, permitted_guild_ids, expires_at) VALUES (?, ?, ?, ?)",
  ).run(token, JSON.stringify(session.identity), JSON.stringify(session.permittedGuildIds), expiresAt);
}

export function deleteOAuthSession(db: Database, token: string): void {
  db.query("DELETE FROM mcp_oauth_sessions WHERE token = ?").run(token);
}

export function deleteExpiredOAuthSessions(db: Database, now: number): void {
  db.query("DELETE FROM mcp_oauth_sessions WHERE expires_at <= ?").run(now);
}
