export interface DiscordIdentity {
  id: string;
  username: string;
  avatar: string | null;
}

export interface McpSession {
  identity: DiscordIdentity;
  permittedGuildIds: string[];
}

interface StoredSession extends McpSession {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** In-memory token -> session map. Nothing here needs to survive a process restart. */
export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  mint(session: McpSession): string {
    this.sweep();
    const token = generateToken();
    this.sessions.set(token, { ...session, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /** Returns the session for a valid, unexpired token; null and evicts the entry otherwise. */
  verify(token: string): McpSession | null {
    const stored = this.sessions.get(token);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const { expiresAt: _expiresAt, ...session } = stored;
    return session;
  }

  // Not called from any route today — kept so a whitelist edit can be made to take effect
  // immediately (rather than waiting out the TTL) by dropping the affected token(s) here.
  revoke(token: string): void {
    this.sessions.delete(token);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, stored] of this.sessions) {
      if (stored.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

const STATE_TTL_MS = 10 * 60 * 1000;

/** Short-lived CSRF nonces for the OAuth authorize -> callback round trip. */
export class StateStore {
  private readonly states = new Map<string, number>();

  issue(): string {
    this.sweep();
    const state = crypto.randomUUID();
    this.states.set(state, Date.now() + STATE_TTL_MS);
    return state;
  }

  consume(state: string): boolean {
    const expiresAt = this.states.get(state);
    this.states.delete(state);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.states) {
      if (expiresAt <= now) this.states.delete(state);
    }
  }
}
