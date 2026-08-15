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

/** In-memory token -> session map. Nothing here needs to survive a process restart. */
export class SessionStore {
  private readonly sessions: TtlMap<McpSession>;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {
    this.sessions = new TtlMap(ttlMs);
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
  }
}
