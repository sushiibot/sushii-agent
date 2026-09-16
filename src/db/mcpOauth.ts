import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, gt, lte } from "drizzle-orm";
import type { RegisteredClient } from "../mcp/server/oauthServer.ts";
import type { DiscordIdentity, McpSession } from "../mcp/server/session.ts";
import { mcpOauthClients, mcpOauthSessions } from "./schema.ts";

export interface StoredEntry<T> {
  key: string;
  value: T;
  expiresAt: number;
}

function ormFor(db: Database) {
  return drizzle({ client: db, schema: { mcpOauthClients, mcpOauthSessions } });
}

export function loadOAuthClients(db: Database, now: number): StoredEntry<RegisteredClient>[] {
  const rows = ormFor(db).select().from(mcpOauthClients).where(gt(mcpOauthClients.expiresAt, now)).all();
  return rows.map((row) => ({
    key: row.clientId,
    value: { clientId: row.clientId, redirectUris: JSON.parse(row.redirectUris) },
    expiresAt: row.expiresAt,
  }));
}

export function saveOAuthClient(db: Database, client: RegisteredClient, expiresAt: number): void {
  const values = { clientId: client.clientId, redirectUris: JSON.stringify(client.redirectUris), expiresAt };
  ormFor(db)
    .insert(mcpOauthClients)
    .values(values)
    .onConflictDoUpdate({ target: mcpOauthClients.clientId, set: values })
    .run();
}

export function deleteExpiredOAuthClients(db: Database, now: number): void {
  ormFor(db).delete(mcpOauthClients).where(lte(mcpOauthClients.expiresAt, now)).run();
}

export function loadOAuthSessions(db: Database, now: number): StoredEntry<McpSession>[] {
  const rows = ormFor(db).select().from(mcpOauthSessions).where(gt(mcpOauthSessions.expiresAt, now)).all();
  return rows.map((row) => ({
    key: row.token,
    value: {
      identity: JSON.parse(row.identity) as DiscordIdentity,
      permittedGuildIds: JSON.parse(row.permittedGuildIds),
    },
    expiresAt: row.expiresAt,
  }));
}

export function saveOAuthSession(db: Database, token: string, session: McpSession, expiresAt: number): void {
  const values = {
    token,
    identity: JSON.stringify(session.identity),
    permittedGuildIds: JSON.stringify(session.permittedGuildIds),
    expiresAt,
  };
  ormFor(db)
    .insert(mcpOauthSessions)
    .values(values)
    .onConflictDoUpdate({ target: mcpOauthSessions.token, set: values })
    .run();
}

export function deleteOAuthSession(db: Database, token: string): void {
  ormFor(db).delete(mcpOauthSessions).where(eq(mcpOauthSessions.token, token)).run();
}

export function deleteExpiredOAuthSessions(db: Database, now: number): void {
  ormFor(db).delete(mcpOauthSessions).where(lte(mcpOauthSessions.expiresAt, now)).run();
}
