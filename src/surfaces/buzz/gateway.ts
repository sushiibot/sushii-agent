import * as nip19 from "nostr-tools/nip19";
import type { AgentCore, ConversationRef, InboundMessage } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import { BuzzCliError, channelIdOf, type BuzzChannel, type BuzzClient, type BuzzEvent } from "./buzzClient.ts";
import { BuzzSurfaceSession } from "./session.ts";

const logger = getLogger("surfaces/buzz/gateway");

// The relay URL is the community, so a surface's conversations share one spaceId (memory + server
// context are scoped to it, analogous to a Discord guild). With multiple relays each gets its own
// spaceId so memory/context never bleed across communities.
const DEFAULT_SPACE_ID = "buzz";
const SURFACE = "buzz" as const;
// Sushi ack reacted onto a mention the moment it's picked up, as a "seen / working on it" signal
// (buzz has no typing indicator).
const SEEN_EMOJI = "🍣";
// server_context column cap; keep the scanned blob under it.
const MAX_CONTEXT = 4000;

/** Renders the community's channels as a server-context blob. Returns body only — the core wraps
 *  it under "## Server Context". */
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

/** Survivable poll cursor (last-processed mention created_at). Injected so the gateway is testable
 *  without the global DB; index.ts backs it with db/buzzState.ts. */
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
  pollIntervalMs: number;
  /** Memory/server-context scope for this relay's community; defaults to "buzz" (single-relay). */
  spaceId?: string;
  /** If set, publish this as the bot's kind:0 display name on boot (best-effort — a relay write). */
  displayName?: string;
  /** Which relay this loop serves, for log correlation across multiple surfaces. */
  relayLabel?: string;
}

/** Starts the buzz mention poll loop. Returns a stop() to clear the interval (for tests/shutdown). */
export function startBuzzSurface(deps: BuzzSurfaceDeps): { stop: () => void } {
  const { core, client, cursor: cursorStore, serverContext, pollIntervalMs, displayName, relayLabel } = deps;
  const spaceId = deps.spaceId ?? DEFAULT_SPACE_ID;
  logger.info({ pollIntervalMs, relay: relayLabel }, "buzz surface starting");

  // Auto-scan the community once on first contact (fresh space with no context), so the first reply
  // already knows the channel layout. Guarded so a failed scan (e.g. relay hasn't admitted the bot)
  // doesn't retry on every mention for the life of the process.
  let scanAttempted = false;
  const ensureCommunityScanned = async (): Promise<void> => {
    if (scanAttempted || serverContext.get() !== null) return;
    scanAttempted = true;
    try {
      const channels = await client.channelsList();
      serverContext.set(formatCommunityContext(channels).slice(0, MAX_CONTEXT));
      logger.info({ channelCount: channels.length, relay: relayLabel }, "buzz community scanned");
    } catch (err) {
      logger.warn({ err, relay: relayLabel }, "buzz community scan failed (awareness limited until restart)");
    }
  };

  // Resolved lazily on the first successful tick (both need a reachable, admitting relay), so a relay
  // that's unreachable or hasn't admitted the bot yet retries each interval and self-heals once added,
  // instead of dying at boot with no recovery. Keeping startup non-blocking also frees the MCP bridge
  // to start listening immediately.
  let ownPubkey: string | null = null;
  let profilePublished = false;

  let cursor = cursorStore.get();
  if (cursor === 0) {
    // First ever run: start from now so we don't replay the entire channel history.
    cursor = Math.floor(Date.now() / 1000);
    cursorStore.set(cursor);
  }

  const LIMIT = 50;
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return; // never overlap a slow poll with the next tick
    polling = true;
    try {
      if (ownPubkey === null) {
        ownPubkey = await client.ownPubkey();
        // Log the npub too — it's the shareable form used to find/mention the bot on a relay.
        const npub = safeNpub(ownPubkey);
        logger.info({ ownPubkey, npub, relay: relayLabel }, "buzz identity resolved");
      }
      if (displayName && !profilePublished) {
        // Idempotent (kind:0 replaceable); best-effort and independent of polling so a failed profile
        // write (relay hiccup / pre-admission) doesn't stall mentions — it just retries next tick.
        try {
          await client.setProfile(displayName);
          profilePublished = true;
          logger.info({ displayName, relay: relayLabel }, "buzz profile published");
        } catch (err) {
          logger.warn({ err, relay: relayLabel, displayName }, "buzz set-profile failed (will retry)");
        }
      }
      const self = ownPubkey;
      // Drain a full (possibly truncated) page immediately instead of waiting a whole interval, so a
      // burst larger than LIMIT can't sit half-processed. Assumes `feed get` returns oldest-first
      // within the since-window (we sort oldest-first regardless); the `cursor === before` guard stops
      // an infinite loop when a full page yields no fresh events.
      for (;;) {
      const before = cursor;
      const events = await client.feedMentions(cursor, LIMIT);
      const fresh = events
        .filter((e) => e.createdAt > cursor && e.pubkey !== self)
        .sort((a, b) => a.createdAt - b.createdAt);

      for (const event of fresh) {
        const channelId = channelIdOf(event);
        if (channelId) {
          // Populate community context before the first answer (once per process, best-effort).
          await ensureCommunityScanned();
          // React "seen" onto the actual mention (best-effort — a failed ack must never block the turn).
          try {
            await client.react(event.id, SEEN_EMOJI);
          } catch (err) {
            logger.warn({ err, eventId: event.id }, "buzz seen-reaction failed");
          }
          // Reply to the thread root, not the mention itself, so replies stay one level deep
          // (Slack-style) instead of nesting deeper with every turn.
          const threadRoot = threadRootOf(event);
          const conversation: ConversationRef = { surface: SURFACE, spaceId, conversationId: threadRoot };
          const session = new BuzzSurfaceSession({ client, ownPubkey: self, channelId, replyToId: threadRoot });
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
        } else {
          logger.warn({ eventId: event.id }, "buzz mention has no channel (h) tag, skipping");
        }
        // Advance per-event so a crash mid-batch never re-replies to already-handled mentions.
        cursor = event.createdAt;
        cursorStore.set(cursor);
      }
      if (events.length < LIMIT || cursor === before) break;
      }
    } catch (err) {
      const category = err instanceof BuzzCliError ? err.category : "other";
      logger.error({ err, category, relay: relayLabel }, "buzz poll failed");
    } finally {
      polling = false;
    }
  };

  void poll(); // respond to anything already waiting, rather than after the first interval
  const interval = setInterval(() => void poll(), pollIntervalMs);
  return { stop: () => clearInterval(interval) };
}
