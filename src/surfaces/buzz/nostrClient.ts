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
// Buzz relays always send a NIP-42 AUTH challenge; this fallback only fires for a relay that never
// challenges, so it proceeds unauthenticated rather than never subscribing.
const AUTH_FALLBACK_MS = 2_000;

/**
 * A single persistent, NIP-42-authenticated connection to a buzz (Nostr) relay. Owns the socket, the
 * auth handshake, one long-lived mention subscription (re-armed on every reconnect), and
 * request/response helpers for publishing events and one-shot queries. All buzz reads and writes go
 * through here — no CLI.
 */
export class NostrRelayConnection {
  private ws: WebSocket | null = null;
  private ready = false;
  private challengeSeen = false;
  private authEventId: string | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private selfPubkey: string | null = null;

  private readonly queries = new Map<string, { events: NostrEvent[]; resolve: (e: NostrEvent[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly publishes = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private mention: { subId: string; getSince: () => number; onEvent: (e: NostrEvent) => void } | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly sk: Uint8Array,
    /** Optional NIP-OA owner-attestation tag appended to the AUTH event. */
    private readonly authTag: string[] | null,
    private readonly relayLabel?: string,
    /** Fired every time the connection becomes ready (initial + each reconnect) — used to re-announce presence. */
    private readonly onReady?: () => void,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.authFallbackTimer) clearTimeout(this.authFallbackTimer);
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  /** True once the socket is open and authenticated (safe to publish/query). */
  isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  setSelfPubkey(hex: string): void { this.selfPubkey = hex; }

  /** Registers the mention subscription. `getSince` is read on each (re)connect so a reconnect
   *  backfills only what was missed. Safe to call before the socket is up. */
  subscribeMentions(subId: string, getSince: () => number, onEvent: (e: NostrEvent) => void): void {
    this.mention = { subId, getSince, onEvent };
    if (this.ready) this.sendMentionReq();
  }

  private connect(): void {
    if (this.closed) return;
    this.ready = false;
    this.challengeSeen = false;
    this.authEventId = null;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      logger.debug({ relay: this.relayLabel }, "buzz ws open");
      // If the relay never challenges (non-buzz), proceed unauthenticated after a grace period.
      this.authFallbackTimer = setTimeout(() => {
        if (!this.challengeSeen && !this.ready && this.ws === ws && ws.readyState === WebSocket.OPEN) {
          this.markReady();
        }
      }, AUTH_FALLBACK_MS);
    });
    ws.addEventListener("message", (ev) => this.onMessage(String((ev as MessageEvent).data)));
    ws.addEventListener("error", () => logger.warn({ relay: this.relayLabel }, "buzz ws error"));
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.onDisconnect();
    });
  }

  private onDisconnect(): void {
    this.ws = null;
    this.ready = false;
    if (this.authFallbackTimer) clearTimeout(this.authFallbackTimer);
    for (const [, p] of this.publishes) { clearTimeout(p.timer); p.reject(new Error("relay disconnected")); }
    this.publishes.clear();
    for (const [, q] of this.queries) { clearTimeout(q.timer); q.reject(new Error("relay disconnected")); }
    this.queries.clear();
    if (this.closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    logger.warn({ relay: this.relayLabel, delay }, "buzz ws disconnected, reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Connection is authenticated (or the relay doesn't challenge) — arm the subscription and signal ready. */
  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.reconnectAttempts = 0;
    if (this.authFallbackTimer) clearTimeout(this.authFallbackTimer);
    if (this.mention) this.sendMentionReq();
    try { this.onReady?.(); } catch { /* callback must not break the connection */ }
  }

  private sendMentionReq(): void {
    if (!this.mention || !this.selfPubkey) return;
    const since = this.mention.getSince();
    this.sendRaw(["REQ", this.mention.subId, { "#p": [this.selfPubkey], since }]);
    logger.debug({ relay: this.relayLabel, since }, "buzz mention REQ sent");
  }

  private respondAuth(challenge: string): void {
    const template = makeAuthEvent(this.wsUrl, challenge) as EventTemplate;
    const tags = this.authTag ? [...template.tags, this.authTag] : template.tags;
    const signed = finalizeEvent({ kind: template.kind, created_at: template.created_at ?? Math.floor(Date.now() / 1000), tags, content: template.content }, this.sk);
    this.authEventId = signed.id;
    this.sendRaw(["AUTH", signed]);
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
      this.challengeSeen = true;
      if (this.authFallbackTimer) clearTimeout(this.authFallbackTimer);
      this.respondAuth(msg[1]);
      return;
    }
    if (type === "OK") {
      const id = msg[1] as string;
      const accepted = msg[2] === true;
      if (id === this.authEventId) {
        if (accepted) this.markReady();
        else logger.error({ relay: this.relayLabel, reason: msg[3] }, "buzz relay rejected AUTH");
        return;
      }
      const pending = this.publishes.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.publishes.delete(id);
        if (accepted) pending.resolve();
        else pending.reject(new Error(typeof msg[3] === "string" ? msg[3] : "relay rejected event"));
      }
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
      if (q) { clearTimeout(q.timer); this.queries.delete(subId); q.reject(new Error(reason || "subscription closed")); }
      if (this.mention && subId === this.mention.subId) {
        // The live subscription was dropped by the relay — reconnect (re-auth + re-REQ) rather than
        // sit silently deaf.
        logger.warn({ relay: this.relayLabel, reason }, "buzz mention subscription closed, reconnecting");
        try { this.ws?.close(); } catch { /* triggers onDisconnect → reconnect */ }
      }
      return;
    }
    if (type === "NOTICE") {
      logger.debug({ relay: this.relayLabel, notice: msg[1] }, "buzz relay notice");
    }
  }

  /** Signs and publishes an event, resolving with its id once the relay ACKs it. */
  publish(template: EventTemplate): Promise<string> {
    const signed = finalizeEvent({ kind: template.kind, created_at: template.created_at ?? Math.floor(Date.now() / 1000), tags: template.tags, content: template.content }, this.sk);
    return new Promise<string>((resolve, reject) => {
      if (!this.isReady()) { reject(new Error("relay not ready")); return; }
      const timer = setTimeout(() => { this.publishes.delete(signed.id); reject(new Error("publish timed out")); }, PUBLISH_TIMEOUT_MS);
      this.publishes.set(signed.id, { resolve: () => resolve(signed.id), reject, timer });
      this.sendRaw(["EVENT", signed]);
    });
  }

  /** One-shot query: REQ, collect EVENTs until EOSE, then CLOSE. Rejects if not connected. */
  query(filter: Filter): Promise<NostrEvent[]> {
    return new Promise<NostrEvent[]>((resolve, reject) => {
      if (!this.isReady()) { reject(new Error("relay not ready")); return; }
      const subId = `q-${Math.random().toString(36).slice(2, 10)}`;
      const timer = setTimeout(() => {
        const q = this.queries.get(subId);
        if (q) { this.queries.delete(subId); this.sendRaw(["CLOSE", subId]); resolve(q.events); }
      }, QUERY_TIMEOUT_MS);
      this.queries.set(subId, { events: [], resolve, reject, timer });
      this.sendRaw(["REQ", subId, filter]);
    });
  }

  private sendRaw(msg: unknown[]): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (err) {
      logger.warn({ err, relay: this.relayLabel }, "buzz ws send failed");
    }
  }
}
