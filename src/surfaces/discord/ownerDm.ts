import type { MessageCreateOptions } from "discord.js";
import { handleOwnerMessage, type MessageCursor, type OwnerRouterDeps } from "../../orchestration/workspace/router.ts";
import type { InboundSurface } from "../../orchestration/workspace/surface.ts";
import { getLogger } from "../../logger.ts";
import { discordInbound, type DiscordInbound } from "./workspaceAdapter.ts";

const log = getLogger("surfaces/discord/ownerDm");

export const OWNER_DM_CURSOR_KEY = "discord:owner_dm_cursor";
export const CATCH_UP_LIMIT = 50;
export const CATCH_UP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CATCH_UP_PAGE_SIZE = 100;
const DISCORD_EPOCH_MS = 1420070400000n;

/** The owner-DM message fields the router needs; the gateway adapts a discord.js Message. */
export interface OwnerDmMessage {
  id: string;
  channelId: string;
  content: string;
  author: { id: string; name: string };
  isVoice: boolean;
  attachments: Array<{ url: string; name: string; contentType: string }>;
  react(emoji: string): Promise<unknown>;
  send(options: string | MessageCreateOptions): Promise<unknown>;
}

export interface OwnerDmDeps<P extends OwnerDmMessage = OwnerDmMessage> extends Omit<OwnerRouterDeps<DiscordInbound<P>>, "cursor" | "surface"> {
  /** Answers the DM in place; the gateway passes its DiscordWorkspaceAdapter. */
  surface: InboundSurface<DiscordInbound<P>>;
  cursor: DmCursor;
}

export interface DmCursor {
  get(): string | null;
  set(id: string): void;
}

/** Moves the cursor forward only, so a slow catch-up item can't rewind past a newer live DM. */
export function advanceCursor(cursor: DmCursor, id: string): void {
  const current = cursor.get();
  if (current === null || BigInt(id) > BigInt(current)) cursor.set(id);
}

/** A DM cursor ordered by snowflake. */
export function snowflakeCursor(cursor: DmCursor): MessageCursor {
  return { advance: (id) => advanceCursor(cursor, id) };
}

/** Routes one owner DM through the surface-neutral owner router. */
export function handleOwnerDm<P extends OwnerDmMessage>(message: P, deps: OwnerDmDeps<P>): Promise<void> {
  return handleOwnerMessage(discordInbound(message), { ...deps, cursor: snowflakeCursor(deps.cursor) });
}

export interface CatchUpCandidate {
  id: string;
  createdTimestamp: number;
  author: { id: string; bot: boolean };
}

/** The smallest snowflake at or after `ms`: Discord's `after` bound for a timestamp. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.floor(ms)) - DISCORD_EPOCH_MS) << 22n).toString();
}

function maxId(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** Owner DMs after the cursor, within the age cap, oldest first. No cursor = nothing to catch up. */
export function selectCatchUp<T extends CatchUpCandidate>(messages: T[], input: { cursor: string | null; ownerId: string; now: number }): T[] {
  if (input.cursor === null) return [];
  const cursor = BigInt(input.cursor);
  return messages
    .filter((m) => !m.author.bot && m.author.id === input.ownerId && BigInt(m.id) > cursor && input.now - m.createdTimestamp <= CATCH_UP_MAX_AGE_MS)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
    .slice(0, CATCH_UP_LIMIT);
}

/** Feeds owner DMs sent while the bot was down through the normal DM router, in order. Pass the cursor
 *  read at ready: a live DM handled meanwhile advances the stored one past the backlog. Pages forward
 *  from max(cursor, now − 24h) so the bot's own messages can't use up the owner-DM budget. */
export async function catchUpOwnerDms<T extends CatchUpCandidate>(input: {
  cursor: string | null;
  ownerId: string;
  now: number;
  /** Messages after `after` in any order, at most `limit`. */
  fetchAfter: (after: string, limit: number) => Promise<T[]>;
  handle: (message: T) => Promise<void>;
  /** DMs the live handler already took since startup; the fallback path has no dedupe of its own. */
  alreadyHandled?: (id: string) => boolean;
}): Promise<number> {
  if (input.cursor === null) return 0;
  let after = maxId(input.cursor, snowflakeAt(input.now - CATCH_UP_MAX_AGE_MS));
  const collected: T[] = [];
  for (;;) {
    const page = await input.fetchAfter(after, CATCH_UP_PAGE_SIZE);
    collected.push(...selectCatchUp(page, input));
    if (page.length < CATCH_UP_PAGE_SIZE || collected.length >= CATCH_UP_LIMIT) break;
    const next = page.reduce((acc, m) => maxId(acc, m.id), after);
    if (next === after) break;
    after = next;
  }
  const pending = selectCatchUp(collected, input).filter((m) => !input.alreadyHandled?.(m.id));
  for (const m of pending) {
    await input.handle(m).catch((err) => log.error({ err, messageId: m.id }, "catch-up DM failed"));
  }
  return pending.length;
}
