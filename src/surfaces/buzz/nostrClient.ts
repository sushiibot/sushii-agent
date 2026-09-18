import { finalizeEvent } from "nostr-tools/pure";
import { makeAuthEvent } from "nostr-tools/nip42";
import { getLogger } from "../../logger.ts";

const logger = getLogger("surfaces/buzz/nostr");

/** A signed Nostr event as it appears on the wire. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
  sig: string;
}

/** The unsigned shape we hand to `finalizeEvent`. */
export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}

type Filter = Record<string, unknown>;

/** http(s):// → ws(s):// and strip a trailing slash, matching the CLI's relay-url normalization. */
export function toWsUrl(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/+$/, "");
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 15_000;

/**
 * A single persistent, NIP-42-authenticated connection to a buzz (Nostr) relay. Owns the socket,
 * the auth handshake, one long-lived mention subscription (re-armed on every reconnect), and
 * request/response helpers for publishing events and one-shot queries. All buzz reads and writes go
 * through here — no CLI.
 */
export class NostrRelayConnection {
  private ws: WebSocket | null = null;
  private authed = false;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending one-shot queries keyed by sub id.
  private readonly queries = new Map<string, { events: NostrEvent[]; resolve: (e: NostrEvent[]) => void; timer: ReturnType<typeof setTimeout> }>();
  // Pending publishes keyed by event id, resolved on the relay's OK.
  private readonly publishes = new Map<string, { resolve: (accepted: boolean) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  // The live mention subscription, re-sent after every (re)auth.
  private mention: { subId: string; getSince: () => number; onEvent: (e: NostrEvent) => void } | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly sk: Uint8Array,
    /** Optional NIP-OA owner-attestation tag appended to the AUTH event. */
    private readonly authTag: string[] | null,
    private readonly relayLabel?: string,
  ) {}

  /** Opens the connection and keeps it open (auto-reconnecting) until close(). Idempotent-ish: call once. */
  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  /** Registers the mention subscription. `getSince` is read on each (re)connect so a reconnect
   *  backfills only what was missed. Safe to call before the socket is up. */
  subscribeMentions(subId: string, getSince: () => number, onEvent: (e: NostrEvent) => void): void {
    this.mention = { subId, getSince, onEvent };
    if (this.authed) this.sendMentionReq();
  }

  private connect(): void {
    if (this.closed) return;
    this.authed = false;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      logger.debug({ relay: this.relayLabel }, "buzz ws open");
      // Buzz always sends an AUTH challenge; if one hasn't arrived shortly, proceed unauthenticated
      // (the mention REQ will be CLOSED with auth-required and we'll learn from that).
      setTimeout(() => {
        if (!this.authed && this.ws === ws && ws.readyState === WebSocket.OPEN) this.onReady();
      }, 300);
    });
    ws.addEventListener("message", (ev) => this.onMessage(String((ev as MessageEvent).data)));
    ws.addEventListener("error", () => logger.warn({ relay: this.relayLabel }, "buzz ws error"));
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.onDisconnect();
    });
  }

  private onDisconnect(): void {
    this.ws = null;
    this.authed = false;
    // Fail in-flight publishes so callers don't hang; queries resolve with what they have.
    for (const [, p] of this.publishes) { clearTimeout(p.timer); p.reject(new Error("relay disconnected")); }
    this.publishes.clear();
    for (const [, q] of this.queries) { clearTimeout(q.timer); q.resolve(q.events); }
    this.queries.clear();
    if (this.closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    logger.warn({ relay: this.relayLabel, delay }, "buzz ws disconnected, reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Called once the connection is usable (post-auth, or post-open if the relay didn't challenge). */
  private onReady(): void {
    if (this.authed) return;
    this.authed = true;
    this.reconnectAttempts = 0;
    if (this.mention) this.sendMentionReq();
  }

  private sendMentionReq(): void {
    if (!this.mention) return;
    const since = this.mention.getSince();
    const filter: Filter = { "#p": [this.selfPubkeyHex()], since };
    this.sendRaw(["REQ", this.mention.subId, filter]);
    logger.debug({ relay: this.relayLabel, since }, "buzz mention REQ sent");
  }

  private onMessage(raw: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type] = msg;

    if (type === "AUTH" && typeof msg[1] === "string") {
      this.respondAuth(msg[1]);
      return;
    }
    if (type === "OK") {
      const id = msg[1] as string;
      const accepted = msg[2] === true;
      const pending = this.publishes.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.publishes.delete(id);
        if (accepted) pending.resolve(true);
        else pending.reject(new Error(typeof msg[3] === "string" ? msg[3] : "relay rejected event"));
      }
      // An OK for our auth event id marks the connection ready.
      if (id === this.authEventId) this.onReady();
      return;
    }
    if (type === "EVENT") {
      const subId = msg[1] as string;
      const event = msg[2] as NostrEvent;
      const q = this.queries.get(subId);
      if (q) { q.events.push(event); return; }
      if (this.mention && subId === this.mention.subId) this.mention.onEvent(event);
      return;
    }
    if (type === "EOSE") {
      const subId = msg[1] as string;
      const q = this.queries.get(subId);
      if (q) {
        clearTimeout(q.timer);
        this.queries.delete(subId);
        this.sendRaw(["CLOSE", subId]);
        q.resolve(q.events);
      }
      return;
    }
    if (type === "CLOSED") {
      const subId = msg[1] as string;
      const reason = typeof msg[2] === "string" ? msg[2] : "";
      const q = this.queries.get(subId);
      if (q) { clearTimeout(q.timer); this.queries.delete(subId); q.resolve(q.events); }
      if (this.mention && subId === this.mention.subId) {
        logger.warn({ relay: this.relayLabel, reason }, "buzz mention subscription closed by relay");
      }
      return;
    }
    if (type === "NOTICE") {
      logger.debug({ relay: this.relayLabel, notice: msg[1] }, "buzz relay notice");
    }
  }

  private authEventId: string | null = null;

  private respondAuth(challenge: string): void {
    const template = makeAuthEvent(this.wsUrl, challenge) as EventTemplate;
    if (this.authTag) template.tags = [...template.tags, this.authTag];
    const signed = finalizeEvent({ kind: template.kind, created_at: template.created_at ?? Math.floor(Date.now() / 1000), tags: template.tags, content: template.content }, this.sk);
    this.authEventId = signed.id;
    this.sendRaw(["AUTH", signed]);
  }

  /** Signs and publishes an event, resolving with its id once the relay ACKs it. */
  publish(template: EventTemplate): Promise<string> {
    const signed = finalizeEvent({ kind: template.kind, created_at: template.created_at ?? Math.floor(Date.now() / 1000), tags: template.tags, content: template.content }, this.sk);
    return new Promise<string>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("relay not connected")); return; }
      const timer = setTimeout(() => { this.publishes.delete(signed.id); reject(new Error("publish timed out")); }, PUBLISH_TIMEOUT_MS);
      this.publishes.set(signed.id, { resolve: () => resolve(signed.id), reject, timer });
      this.sendRaw(["EVENT", signed]);
    });
  }

  /** One-shot query: REQ, collect EVENTs until EOSE, then CLOSE. Resolves with the collected events. */
  query(filter: Filter): Promise<NostrEvent[]> {
    return new Promise<NostrEvent[]>((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { resolve([]); return; }
      const subId = `q-${Math.random().toString(36).slice(2, 10)}`;
      const timer = setTimeout(() => {
        const q = this.queries.get(subId);
        if (q) { this.queries.delete(subId); this.sendRaw(["CLOSE", subId]); resolve(q.events); }
      }, QUERY_TIMEOUT_MS);
      this.queries.set(subId, { events: [], resolve, timer });
      this.sendRaw(["REQ", subId, filter]);
    });
  }

  private selfPubkeyHex(): string {
    // Derived once from the auth event we build; simplest is to import getPublicKey, but the caller
    // already knows it — set via setSelfPubkey to avoid a second derivation.
    if (!this._selfPubkey) throw new Error("self pubkey not set");
    return this._selfPubkey;
  }
  private _selfPubkey: string | null = null;
  setSelfPubkey(hex: string): void { this._selfPubkey = hex; }

  private sendRaw(msg: unknown[]): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn({ err, relay: this.relayLabel }, "buzz ws send failed");
    }
  }
}
