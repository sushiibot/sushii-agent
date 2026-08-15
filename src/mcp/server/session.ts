import type { Database } from "bun:sqlite";
import { deleteExpiredOAuthSessions, deleteOAuthSession, loadOAuthSessions, saveOAuthSession } from "../../db/mcpOauth.ts";
import { randomId, TtlMap } from "./ttlStore.ts";

export interface DiscordIdentity {
  id: string;
  username: string;
  avatar: string | null;
}

export interface McpSession {
  identity: DiscordIdentity;
  permittedGuildIds: string[];
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * Token -> session map, persisted to SQLite when a Database is provided (production) so a
 * deploy doesn't log every MCP bridge user out — falls back to in-memory-only otherwise (tests,
 * or before the DB is initialized).
 */
export class SessionStore {
  private readonly sessions: TtlMap<McpSession>;

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly db?: Database,
  ) {
    this.sessions = new TtlMap(ttlMs, undefined, db ? (token, session, expiresAt) => saveOAuthSession(db, token, session, expiresAt) : undefined);
    if (db) {
      const now = Date.now();
      deleteExpiredOAuthSessions(db, now);
      for (const { key, value, expiresAt } of loadOAuthSessions(db, now)) {
        this.sessions.restore(key, value, expiresAt);
      }
    }
  }

  get ttlSeconds(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  mint(session: McpSession): string {
    const token = randomId(32);
    this.sessions.set(token, session);
    return token;
  }

  /** Returns the session for a valid, unexpired token; null and evicts the entry otherwise. */
  verify(token: string): McpSession | null {
    return this.sessions.peek(token);
  }

  // Not called from any route today — kept so a whitelist edit can be made to take effect
  // immediately (rather than waiting out the TTL) by dropping the affected token(s) here.
  revoke(token: string): void {
    this.sessions.delete(token);
    if (this.db) deleteOAuthSession(this.db, token);
  }
}
