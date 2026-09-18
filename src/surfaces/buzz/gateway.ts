import * as nip19 from "nostr-tools/nip19";
import type { AgentCore, ConversationRef, InboundMessage } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import { channelIdOf, type BuzzChannel, type BuzzClient, type BuzzEvent } from "./buzzClient.ts";
import { BuzzSurfaceSession } from "./session.ts";

const logger = getLogger("surfaces/buzz/gateway");

// The relay URL is the community, so a surface's conversations share one spaceId (memory + server
// context are scoped to it, analogous to a Discord guild). With multiple relays each gets its own
// spaceId so memory/context never bleed across communities.
const DEFAULT_SPACE_ID = "buzz";
const SURFACE = "buzz" as const;
// Sushi ack reacted onto a mention the moment it's picked up, as a "seen / working on it" signal.
const SEEN_EMOJI = "🍣";
// server_context column cap; keep the scanned blob under it.
const MAX_CONTEXT = 4000;
// Presence TTL on the relay is 180s; refresh well inside that so the bot never flips to offline.
const PRESENCE_HEARTBEAT_MS = 120_000;

/** Renders the community's channels as a server-context blob (body only — the core wraps it). */
function formatCommunityContext(channels: BuzzChannel[]): string {
  if (!channels.length) return "This community has no channels visible to the bot yet.";
  const lines = channels.map((c) => {
    const meta = [c.topic, c.purpose].filter(Boolean).join(" — ");
    return meta ? `- #${c.name} (\`${c.id}\`): ${meta}` : `- #${c.name} (\`${c.id}\`)`;
  });
  return `Channels in this community:\n${lines.join("\n")}`;
}

/** Stable per-thread conversation key: the NIP-10 root event id, or the event's own id for a
 *  top-level mention (which becomes the thread root once we reply to it). */
function threadRootOf(event: BuzzEvent): string {
  const rootTag = event.tags.find((t) => t[0] === "e" && t[3] === "root");
  if (rootTag?.[1]) return rootTag[1];
  const anyE = event.tags.find((t) => t[0] === "e");
  if (anyE?.[1]) return anyE[1];
  return event.id;
}

/** Bech32 npub for a hex pubkey; returns null if encoding fails so a bad key never crashes startup. */
function safeNpub(hexPubkey: string): string | null {
  try {
    return nip19.npubEncode(hexPubkey);
  } catch {
    return null;
  }
}

/** Survivable backfill cursor (last-handled mention created_at), for reconnect + restart. Injected so
 *  the gateway is testable without the global DB; index.ts backs it with db/buzzState.ts. */
export interface CursorStore {
  get(): number;
  set(cursor: number): void;
}

/** Per-community server-context port (scoped to this surface's spaceId). Injected so the gateway is
 *  testable without the global DB; index.ts backs it with the shared SpaceMemoryStore. */
export interface ServerContextStore {
  get(): string | null;
  set(content: string): void;
}

export interface BuzzSurfaceDeps {
  core: AgentCore;
  client: BuzzClient;
  cursor: CursorStore;
  serverContext: ServerContextStore;
  /** Memory/server-context scope for this relay's community; defaults to "buzz" (single-relay). */
  spaceId?: string;
  /** If set, publish this as the bot's kind:0 display name on boot (best-effort). */
  displayName?: string;
  /** Which relay this loop serves, for log correlation across multiple surfaces. */
  relayLabel?: string;
}

/** Starts the buzz mention subscription + presence heartbeat. Returns stop() (for tests/shutdown). */
export function startBuzzSurface(deps: BuzzSurfaceDeps): { stop: () => void } {
  const { core, client, cursor: cursorStore, serverContext, displayName, relayLabel } = deps;
  const spaceId = deps.spaceId ?? DEFAULT_SPACE_ID;
  logger.info({ relay: relayLabel }, "buzz surface starting");

  // First-run community scan, once per process, race-guarded (the subscription callback is concurrent
  // unlike the old sequential poll loop). In-flight scan is shared so concurrent mentions await it.
  let scanAttempted = false;
  let scanInFlight: Promise<void> | null = null;
  const ensureCommunityScanned = async (): Promise<void> => {
    if (serverContext.get() !== null) return;
    if (scanInFlight) { await scanInFlight; return; }
    if (scanAttempted) return;
    scanAttempted = true;
    scanInFlight = (async () => {
      try {
        const channels = await client.channelsList();
        serverContext.set(formatCommunityContext(channels).slice(0, MAX_CONTEXT));
        logger.info({ channelCount: channels.length, relay: relayLabel }, "buzz community scanned");
      } catch (err) {
        logger.warn({ err, relay: relayLabel }, "buzz community scan failed (awareness limited until restart)");
      }
    })();
    await scanInFlight;
    scanInFlight = null;
  };

  const handleEvent = async (event: BuzzEvent): Promise<void> => {
    const channelId = channelIdOf(event);
    if (!channelId) {
      logger.warn({ eventId: event.id }, "buzz mention has no channel (h) tag, skipping");
      return;
    }
    // Populate community context before the first answer (once per process, best-effort).
    await ensureCommunityScanned();
    // React "seen" onto the mention (best-effort — a failed ack must never block the turn).
    try {
      await client.react(event.id, SEEN_EMOJI);
    } catch (err) {
      logger.warn({ err, eventId: event.id }, "buzz seen-reaction failed");
    }
    // Reply to the thread root, not the mention itself, so replies stay one level deep (Slack-style).
    const threadRoot = threadRootOf(event);
    const conversation: ConversationRef = { surface: SURFACE, spaceId, conversationId: threadRoot };
    const session = new BuzzSurfaceSession({ client, ownPubkey: selfPubkey, channelId, replyToId: threadRoot });
    const inbound: InboundMessage = {
      conversation,
      author: { surface: SURFACE, userId: event.pubkey, username: null },
      text: event.content,
      platform: { surface: "buzz" },
    };
    try {
      const res = await core.handleInbound(inbound, session);
      if (res.status === "error") logger.error({ eventId: event.id, message: res.message }, "buzz turn errored");
    } catch (err) {
      logger.error({ err, eventId: event.id }, "buzz turn threw");
    }
    // Persist the cursor for cross-restart backfill (the client tracks the in-process reconnect cursor).
    cursorStore.set(Math.max(cursorStore.get(), event.createdAt));
  };

  let selfPubkey = "";
  let subscription: { stop: () => void } | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  void (async () => {
    selfPubkey = await client.ownPubkey();
    logger.info({ ownPubkey: selfPubkey, npub: safeNpub(selfPubkey), relay: relayLabel }, "buzz identity resolved");

    if (displayName) {
      try { await client.setProfile(displayName); } catch (err) { logger.warn({ err, relay: relayLabel }, "buzz set-profile failed"); }
    }

    const announcePresence = async () => {
      try { await client.setPresence("online"); } catch (err) { logger.debug({ err, relay: relayLabel }, "buzz presence heartbeat failed"); }
    };
    await announcePresence();
    heartbeat = setInterval(() => void announcePresence(), PRESENCE_HEARTBEAT_MS);

    let cursor = cursorStore.get();
    if (cursor === 0) {
      // First ever run: start from now so we don't replay the entire channel history.
      cursor = Math.floor(Date.now() / 1000);
      cursorStore.set(cursor);
    }
    subscription = client.subscribeMentions(cursor, handleEvent);
  })();

  return {
    stop: () => {
      if (heartbeat) clearInterval(heartbeat);
      subscription?.stop();
      void client.setPresence("offline").catch(() => {});
    },
  };
}
