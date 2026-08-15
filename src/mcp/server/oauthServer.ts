import type { Database } from "bun:sqlite";
import { deleteExpiredOAuthClients, loadOAuthClients, saveOAuthClient } from "../../db/mcpOauth.ts";
import type { DiscordIdentity } from "./session.ts";
import { randomId, TtlMap } from "./ttlStore.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);
// The whole 127.0.0.0/8 block is loopback (RFC 8252 §7.3), not just 127.0.0.1.
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * A redirect_uri must be an absolute https URL, or http restricted to loopback (RFC 8252) —
 * the pattern native/CLI MCP clients use for their local callback listener. No fragment is
 * allowed per RFC 6749 §3.1.2.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return LOOPBACK_HOSTS.has(url.hostname) || IPV4_LOOPBACK.test(url.hostname);
}

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
}

const CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Dynamic client registry (RFC 7591), persisted to SQLite when a Database is provided
 * (production) — without this, every deploy would wipe every MCP client's registration,
 * forcing it to re-register (and its user to re-consent) on the next login attempt.
 */
export class ClientStore {
  private readonly clients: TtlMap<RegisteredClient>;

  constructor(
    ttlMs: number = CLIENT_TTL_MS,
    db?: Database,
  ) {
    this.clients = new TtlMap(ttlMs, undefined, db ? (_key, client, expiresAt) => saveOAuthClient(db, client, expiresAt) : undefined);
    if (db) {
      const now = Date.now();
      deleteExpiredOAuthClients(db, now);
      for (const { key, value, expiresAt } of loadOAuthClients(db, now)) {
        this.clients.restore(key, value, expiresAt);
      }
    }
  }

  register(redirectUris: string[]): RegisteredClient {
    const client = { clientId: randomId(24, "client"), redirectUris };
    this.clients.set(client.clientId, client);
    return client;
  }

  get(clientId: string): RegisteredClient | null {
    return this.clients.peek(clientId);
  }
}

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  clientState: string | undefined;
  codeChallenge: string;
}

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

/**
 * Bridges the client's own authorize request across the Discord OAuth round trip. Issued
 * as the `state` param we send to Discord, so it doubles as our CSRF nonce.
 */
export class PendingAuthorizationStore {
  private readonly pending: TtlMap<PendingAuthorization>;

  constructor(ttlMs: number = PENDING_AUTH_TTL_MS) {
    this.pending = new TtlMap(ttlMs);
  }

  issue(auth: PendingAuthorization): string {
    const nonce = crypto.randomUUID();
    this.pending.set(nonce, auth);
    return nonce;
  }

  /** Single-use: consuming a nonce removes it whether or not it was still valid. */
  consume(nonce: string): PendingAuthorization | null {
    return this.pending.take(nonce);
  }
}

export interface PendingConsent {
  identity: DiscordIdentity;
  permittedGuildIds: string[];
  clientId: string;
  redirectUri: string;
  clientState: string | undefined;
  codeChallenge: string;
}

const PENDING_CONSENT_TTL_MS = 5 * 60 * 1000;

/**
 * Holds a resolved Discord identity between rendering the consent page and the user's
 * approve/deny submission, so the client's redirect_uri can't be reached without an explicit
 * user decision (an attacker-registered client silently minting a token off a Discord login
 * approval is exactly the gap this closes).
 */
export class PendingConsentStore {
  private readonly pending: TtlMap<PendingConsent>;

  constructor(ttlMs: number = PENDING_CONSENT_TTL_MS) {
    this.pending = new TtlMap(ttlMs);
  }

  issue(consent: PendingConsent): string {
    const token = randomId(24, "consent");
    this.pending.set(token, consent);
    return token;
  }

  /** Single-use: consuming a token removes it whether or not it was still valid. */
  consume(token: string): PendingConsent | null {
    return this.pending.take(token);
  }
}

export interface AuthorizationCode {
  identity: DiscordIdentity;
  permittedGuildIds: string[];
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

const CODE_TTL_MS = 60 * 1000;

/** Short-lived, single-use authorization codes (RFC 6749 4.1.2) exchanged at the token endpoint. */
export class AuthorizationCodeStore {
  private readonly codes: TtlMap<AuthorizationCode>;

  constructor(ttlMs: number = CODE_TTL_MS) {
    this.codes = new TtlMap(ttlMs);
  }

  issue(auth: AuthorizationCode): string {
    const code = randomId(24, "code");
    this.codes.set(code, auth);
    return code;
  }

  /** Single-use: consuming a code removes it whether or not it was still valid. */
  consume(code: string): AuthorizationCode | null {
    return this.codes.take(code);
  }
}

// RFC 7636 §4.1/§4.2: 43-128 chars from the unreserved URL charset. A code_challenge is always
// exactly this shape (base64url of a SHA-256 digest is 43 chars); code_verifier is client-chosen
// but must fit the same envelope. Rejecting malformed values here means a bad request fails fast
// at /oauth/authorize or /oauth/token instead of limping through to an opaque invalid_grant later.
const PKCE_FORMAT = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidPkceValue(value: string): boolean {
  return PKCE_FORMAT.test(value);
}

/** PKCE S256 verification (RFC 7636): challenge must equal base64url(sha256(verifier)). */
export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const computed = Buffer.from(digest).toString("base64url");
  return computed === codeChallenge;
}
