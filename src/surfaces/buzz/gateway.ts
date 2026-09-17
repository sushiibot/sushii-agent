import type { AgentCore, ConversationRef, InboundMessage } from "../../core/contracts.ts";
import { getLogger } from "../../logger.ts";
import { BuzzCliError, channelIdOf, type BuzzClient, type BuzzEvent } from "./buzzClient.ts";
import { BuzzSurfaceSession } from "./session.ts";

const logger = getLogger("surfaces/buzz/gateway");

// Single-community: the relay URL is the community, so every buzz conversation shares one spaceId
// (memory + server context are scoped to it, analogous to a Discord guild).
const BUZZ_SPACE_ID = "buzz";
const SURFACE = "buzz" as const;

/** Stable per-thread conversation key: the NIP-10 root event id, or the event's own id for a
 *  top-level mention (which becomes the thread root once we reply to it). */
function threadRootOf(event: BuzzEvent): string {
  const rootTag = event.tags.find((t) => t[0] === "e" && t[3] === "root");
  if (rootTag?.[1]) return rootTag[1];
  const anyE = event.tags.find((t) => t[0] === "e");
  if (anyE?.[1]) return anyE[1];
  return event.id;
}

/** Survivable poll cursor (last-processed mention created_at). Injected so the gateway is testable
 *  without the global DB; index.ts backs it with db/buzzState.ts. */
export interface CursorStore {
  get(): number;
  set(cursor: number): void;
}

export interface BuzzSurfaceDeps {
  core: AgentCore;
  client: BuzzClient;
  cursor: CursorStore;
  pollIntervalMs: number;
}

/** Starts the buzz mention poll loop. Returns a stop() to clear the interval (for tests/shutdown). */
export async function startBuzzSurface(deps: BuzzSurfaceDeps): Promise<{ stop: () => void }> {
  const { core, client, cursor: cursorStore, pollIntervalMs } = deps;
  const ownPubkey = await client.ownPubkey();
  logger.info({ ownPubkey, pollIntervalMs }, "buzz surface starting");

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
      // Drain a full (possibly truncated) page immediately instead of waiting a whole interval, so a
      // burst larger than LIMIT can't sit half-processed. Assumes `feed get` returns oldest-first
      // within the since-window (we sort oldest-first regardless); the `cursor === before` guard stops
      // an infinite loop when a full page yields no fresh events.
      for (;;) {
      const before = cursor;
      const events = await client.feedMentions(cursor, LIMIT);
      const fresh = events
        .filter((e) => e.createdAt > cursor && e.pubkey !== ownPubkey)
        .sort((a, b) => a.createdAt - b.createdAt);

      for (const event of fresh) {
        const channelId = channelIdOf(event);
        if (channelId) {
          const conversation: ConversationRef = { surface: SURFACE, spaceId: BUZZ_SPACE_ID, conversationId: threadRootOf(event) };
          const session = new BuzzSurfaceSession({ client, ownPubkey, channelId, replyToId: event.id });
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
      logger.error({ err, category }, "buzz poll failed");
    } finally {
      polling = false;
    }
  };

  void poll(); // respond to anything already waiting, rather than after the first interval
  const interval = setInterval(() => void poll(), pollIntervalMs);
  return { stop: () => clearInterval(interval) };
}
