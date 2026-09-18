import { getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import { getLogger } from "../../logger.ts";
import { NostrRelayConnection, toWsUrl, type NostrEvent } from "./nostrClient.ts";

const logger = getLogger("surfaces/buzz/client");

/** A channel message event as the surface consumes it. */
export interface BuzzEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  createdAt: number;
  tags: string[][];
}

export interface BuzzSendResult {
  eventId: string;
  accepted: boolean;
}

/** A community channel (kind:41 metadata). Only `id` is guaranteed. */
export interface BuzzChannel {
  id: string;
  name: string;
  topic?: string;
  purpose?: string;
  description?: string;
  visibility?: string;
}

export type PresenceStatus = "online" | "away" | "offline";

// Buzz Nostr event kinds (from buzz-core/src/kind.rs + buzz-sdk builders / buzz-cli channels list).
const KIND_PROFILE = 0;
const KIND_REACTION = 7;
const KIND_CHANNEL_MESSAGE = 9;
const KIND_CHANNEL_METADATA = 39000; // NIP-29 channel metadata; id in `d` tag, name/about in tags
const KIND_PRESENCE = 20001;
const KIND_MEMBER_ADDED_NOTIFICATION = 44100; // "you were added to a channel" — global, p-tagged
const KIND_DM_CREATED = 41001; // a new DM channel was opened with us — global, p-tagged

/** The buzz operations the surface needs. Reads are push (a live subscription); writes are signed
 *  event publishes. Injected so the gateway/session can be tested without a relay. */
export interface BuzzClient {
  /** The agent's own hex pubkey (derived offline from the key). */
  ownPubkey(): Promise<string>;
  /** Publish the bot's kind:0 profile display name. */
  setProfile(displayName: string): Promise<void>;
  /** Publish a presence update (kind:20001). TTL on the relay is 180s — refresh faster than that. */
  setPresence(status: PresenceStatus): Promise<void>;
  /** Subscribe to mentions (events p-tagging us) with created_at ≥ sinceTs. `onEvent` fires for each
   *  new mention, oldest first, live. Returns a stop() to tear the subscription down. */
  subscribeMentions(sinceTs: number, onEvent: (e: BuzzEvent) => void | Promise<void>): { stop: () => void };
  /** Post a reply into `channelId`, threaded under `replyToId` (the thread root). */
  send(channelId: string, content: string, replyToId?: string): Promise<BuzzSendResult>;
  /** Add an emoji reaction to an event (NIP-25). Used as a lightweight "seen" ack. */
  react(eventId: string, emoji: string): Promise<void>;
  /** Channels visible to the bot in this community — the scannable structure for server context. */
  channelsList(limit?: number): Promise<BuzzChannel[]>;
}

/** Decodes an nsec/hex private key into raw bytes. */
function decodeSecretKey(raw: string): Uint8Array {
  const key = raw.trim();
  if (key.startsWith("nsec")) {
    const decoded = nip19.decode(key);
    if (decoded.type !== "nsec") throw new Error("BUZZ_PRIVATE_KEY is not a valid nsec");
    return decoded.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Uint8Array.from(Buffer.from(key, "hex"));
  throw new Error("BUZZ_PRIVATE_KEY must be 64-char hex or an nsec");
}

/** Native buzz client over a persistent NIP-42 Nostr WebSocket — no CLI. */
export class NostrBuzzClient implements BuzzClient {
  private readonly sk: Uint8Array;
  private readonly pubkey: string;
  private conn: NostrRelayConnection | null = null;
  private readonly wsUrl: string;
  private readonly authTag: string[] | null;
  private latestSeen = 0;
  private lastPresence: PresenceStatus | null = null;
  private lastProfile: string | null = null;
  private mentionHandler: ((e: BuzzEvent) => void | Promise<void>) | null = null;
  private readonly seen = new Set<string>();
  private readonly subscribedChannels = new Set<string>();
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    env: { privateKey: string; relayUrl?: string; authTag?: string },
    private readonly relayLabel?: string,
  ) {
    this.sk = decodeSecretKey(env.privateKey);
    this.pubkey = getPublicKey(this.sk);
    this.wsUrl = toWsUrl(env.relayUrl?.trim() || "http://localhost:3000");
    this.authTag = env.authTag ? (JSON.parse(env.authTag) as string[]) : null;
  }

  private connection(): NostrRelayConnection {
    if (!this.conn) {
      // On every (re)connect: (re)announce profile + presence, and (re)subscribe to mentions. Both
      // must happen after auth, and channel membership may have changed, so it re-runs each connect.
      const onReady = () => {
        if (this.lastProfile) void this.conn?.publish(profileEvent(this.lastProfile)).catch((err) => logger.debug({ err, relay: this.relayLabel }, "buzz reconnect profile re-announce failed"));
        if (this.lastPresence) void this.conn?.publish(presenceEvent(this.lastPresence)).catch((err) => logger.debug({ err, relay: this.relayLabel }, "buzz reconnect presence re-announce failed"));
        void this.resubscribe();
      };
      this.conn = new NostrRelayConnection(this.wsUrl, this.sk, this.authTag, this.relayLabel, onReady);
      this.conn.start();
    }
    return this.conn;
  }

  /** Routes an incoming mention event to the surface handler (dedup + skip own + advance cursor). */
  private readonly handleRaw = (raw: NostrEvent): void => {
    if (raw.pubkey === this.pubkey) return; // never react to our own posts
    if (this.seen.has(raw.id)) return; // dedup across channels + reconnect replays
    this.seen.add(raw.id);
    if (this.seen.size > 5000) this.seen.clear();
    this.latestSeen = Math.max(this.latestSeen, raw.created_at);
    void this.mentionHandler?.(toBuzzEvent(raw));
  };

  /** (Re)subscribe on connect: a global sub for "added to a channel/DM" notifications (live channel
   *  discovery, no polling), plus one per-channel mention sub for every channel the bot is in.
   *  Channel messages are only fanned out to channel-scoped (`#h`) subs, never global ones. */
  private async resubscribe(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.mentionHandler) return;
    this.subscribedChannels.clear(); // the socket reset cleared all subs; re-arm from scratch
    // Notifications p-tagging us ARE delivered to a global sub; new-channel/DM events trigger a resync.
    conn.subscribe(
      "membership",
      { kinds: [KIND_MEMBER_ADDED_NOTIFICATION, KIND_DM_CREATED], "#p": [this.pubkey], since: this.latestSeen },
      () => this.scheduleChannelResync(),
    );
    await this.syncChannels();
  }

  /** Adds a per-channel mention subscription for any channel we're not already subscribed to. */
  private async syncChannels(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.mentionHandler) return;
    try {
      const channels = await this.channelsList();
      const since = this.latestSeen;
      let added = 0;
      for (const ch of channels) {
        if (this.subscribedChannels.has(ch.id)) continue;
        conn.subscribe(`m:${ch.id}`, { "#h": [ch.id], "#p": [this.pubkey], since }, this.handleRaw);
        this.subscribedChannels.add(ch.id);
        added++;
      }
      if (added) logger.info({ added, total: this.subscribedChannels.size, relay: this.relayLabel }, "buzz mention subscriptions armed");
    } catch (err) {
      logger.error({ err, relay: this.relayLabel }, "buzz failed to arm mention subscriptions");
    }
  }

  /** Debounce channel resyncs so a burst of membership events triggers a single re-scan. */
  private scheduleChannelResync(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setTimeout(() => { this.resyncTimer = null; void this.syncChannels(); }, 2_000);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- offline derivation; async for the contract
  async ownPubkey(): Promise<string> {
    return this.pubkey;
  }

  async setProfile(displayName: string): Promise<void> {
    // Record intent; publish now if connected, else the onReady hook publishes on connect.
    this.lastProfile = displayName;
    const conn = this.connection();
    if (conn.isReady()) await conn.publish(profileEvent(displayName));
  }

  async setPresence(status: PresenceStatus): Promise<void> {
    this.lastPresence = status;
    const conn = this.connection();
    if (conn.isReady()) await conn.publish(presenceEvent(status));
  }

  subscribeMentions(sinceTs: number, onEvent: (e: BuzzEvent) => void | Promise<void>): { stop: () => void } {
    this.latestSeen = Math.max(this.latestSeen, sinceTs);
    this.mentionHandler = onEvent;
    const conn = this.connection(); // starts the socket; resubscribe() runs from the onReady hook
    return { stop: () => conn.close() };
  }

  async send(channelId: string, content: string, replyToId?: string): Promise<BuzzSendResult> {
    const tags: string[][] = [["h", channelId]];
    if (replyToId) tags.push(["e", replyToId, "", "reply"]);
    const eventId = await this.connection().publish({ kind: KIND_CHANNEL_MESSAGE, content, tags });
    return { eventId, accepted: true };
  }

  async react(eventId: string, emoji: string): Promise<void> {
    await this.connection().publish({ kind: KIND_REACTION, content: emoji, tags: [["e", eventId]] });
  }

  async channelsList(limit = 500): Promise<BuzzChannel[]> {
    const events = await this.connection().query({ kinds: [KIND_CHANNEL_METADATA], limit });
    return events.map(normalizeChannel).filter((c): c is BuzzChannel => c !== null);
  }
}

function profileEvent(displayName: string) {
  return { kind: KIND_PROFILE, content: JSON.stringify({ name: displayName }), tags: [] as string[][] };
}

function presenceEvent(status: PresenceStatus) {
  return { kind: KIND_PRESENCE, content: status, tags: [["status", status]] };
}

function toBuzzEvent(e: NostrEvent): BuzzEvent {
  return { id: e.id, pubkey: e.pubkey, kind: e.kind, content: e.content, createdAt: e.created_at, tags: Array.isArray(e.tags) ? e.tags : [] };
}

/** Channel UUID from a message's `h` tag; null if absent. */
export function channelIdOf(event: BuzzEvent): string | null {
  const tag = event.tags.find((t) => t[0] === "h");
  return tag?.[1] ?? null;
}

/** kind:39000 channel metadata → BuzzChannel. The channel id is the `d` tag; name/about live in
 *  their own tags (`["name", …]`, `["about", …]`), not the content. Tolerant: missing fields drop,
 *  a row with no id returns null. */
function normalizeChannel(e: NostrEvent): BuzzChannel | null {
  const tag = (key: string): string | undefined => e.tags.find((t) => t[0] === key)?.[1];
  const id = tag("d") ?? tag("h");
  if (!id) return null;
  const about = tag("about") ?? tag("topic");
  return {
    id,
    name: tag("name") ?? id,
    topic: about,
    purpose: tag("purpose"),
    description: about,
    visibility: e.tags.some((t) => t[0] === "private") ? "private" : e.tags.some((t) => t[0] === "public") ? "open" : undefined,
  };
}
