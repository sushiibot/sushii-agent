import { ContainerBuilder, MessageFlags, TextDisplayBuilder, type MessageCreateOptions } from "discord.js";
import type { ChatMessageMode } from "../../orchestration/contracts.ts";
import { mayHaveBeenAccepted } from "../../orchestration/transport/server.ts";
import { getLogger } from "../../logger.ts";
import { ACCENT, OFFLINE_NOTICE, type WorkspaceLink } from "./workspaceLink.ts";

const log = getLogger("surfaces/discord/ownerDm");

export const OWNER_DM_CURSOR_KEY = "discord:owner_dm_cursor";
export const CATCH_UP_LIMIT = 50;
export const CATCH_UP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CATCH_UP_PAGE_SIZE = 100;
const DISCORD_EPOCH_MS = 1420070400000n;

const NEW_COMMANDS = new Set(["!new", "!reset", "!clear"]);
const STOP_COMMAND = "!stop";

/** The owner-DM message fields the router needs; the gateway adapts a discord.js Message. */
export interface OwnerDmMessage {
  id: string;
  content: string;
  author: { id: string; name: string };
  isVoice: boolean;
  attachments: Array<{ url: string; name: string; contentType: string }>;
  react(emoji: string): Promise<unknown>;
  send(options: string | MessageCreateOptions): Promise<unknown>;
}

export interface OwnerDmDeps {
  workspaceEnabled: boolean;
  transcriptionEnabled: boolean;
  link: Pick<WorkspaceLink, "isConnected" | "sendMessage" | "abort" | "newSession" | "recordOffline">;
  transcribe(message: OwnerDmMessage): Promise<string | null>;
  /** Runs the in-process DM agent; resolves to the reply text it delivered, if any. */
  runInProcess(message: OwnerDmMessage, text: string, options: { notice?: string }): Promise<string | null>;
  /** The in-process `!new`: clears the DM conversation history. */
  resetInProcess(message: OwnerDmMessage): Promise<void>;
  cursor: DmCursor;
}

export interface DmCursor {
  get(): string | null;
  set(id: string): void;
}

export function voiceEcho(transcript: string): string {
  return `-# 🎙️ ${transcript}`;
}

export function modeReaction(mode: ChatMessageMode): string | null {
  if (mode === "prompt") return "👀";
  if (mode === "steer") return "↪️";
  return null;
}

/** Moves the cursor forward only, so a slow catch-up item can't rewind past a newer live DM. */
export function advanceCursor(cursor: DmCursor, id: string): void {
  const current = cursor.get();
  if (current === null || BigInt(id) > BigInt(current)) cursor.set(id);
}

function newSessionReply(): MessageCreateOptions {
  const container = new ContainerBuilder().setAccentColor(ACCENT.success).addTextDisplayComponents(new TextDisplayBuilder({ content: "✅ New session." }));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Routes one owner DM: to the workspace when enabled and connected, else to the in-process agent. */
export async function handleOwnerDm(message: OwnerDmMessage, deps: OwnerDmDeps): Promise<void> {
  try {
    await route(message, deps);
  } finally {
    advanceCursor(deps.cursor, message.id);
  }
}

async function route(message: OwnerDmMessage, deps: OwnerDmDeps): Promise<void> {
  const { link } = deps;
  const command = message.content.trim().toLowerCase();
  const workspace = deps.workspaceEnabled && link.isConnected();

  if (NEW_COMMANDS.has(command)) {
    if (!workspace) {
      await deps.resetInProcess(message);
      return;
    }
    await message.react("🧠").catch(() => {});
    try {
      await link.newSession();
      await message.send(newSessionReply()).catch(() => {});
    } catch (err) {
      log.warn({ err }, "chat/new failed");
      await message.send(`Couldn't start a new session: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
    return;
  }

  if (deps.workspaceEnabled && command === STOP_COMMAND) {
    if (!workspace) {
      await message.send("-# ⚠️ workspace offline — nothing to stop").catch(() => {});
      return;
    }
    try {
      await link.abort();
      await message.react("⏹️").catch(() => {});
    } catch (err) {
      log.warn({ err }, "chat/abort failed");
      await message.send(`Couldn't stop: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
    return;
  }

  let text = message.content;
  let voice = false;
  if (deps.transcriptionEnabled && message.isVoice) {
    await message.react("🎙️").catch(() => {});
    const transcript = await deps.transcribe(message);
    if (!transcript) {
      await message.send("Sorry, I couldn't transcribe that voice message.").catch(() => {});
      return;
    }
    text = transcript;
    voice = true;
    await message.send(voiceEcho(transcript)).catch(() => {});
  }

  if (workspace) {
    // A voice message's audio is already transcribed; only forward real attachments.
    const attachments = voice ? [] : message.attachments;
    try {
      const res = await link.sendMessage({
        messageId: message.id,
        text,
        kind: "user",
        author: message.author,
        ...(attachments.length ? { attachments } : {}),
        ...(voice ? { voice: true } : {}),
      });
      const emoji = modeReaction(res.mode);
      if (emoji) await message.react(emoji).catch(() => {});
      return;
    } catch (err) {
      // The workspace dedupes by messageId and answers a DM it took, so answering here too would double-reply.
      if (mayHaveBeenAccepted(err) && link.isConnected()) {
        log.warn({ err, messageId: message.id }, "chat/message unconfirmed while the workspace is connected; leaving it to the workspace");
        await message.react("⏳").catch(() => {});
        return;
      }
      log.warn({ err, messageId: message.id }, "chat/message not accepted; answering in-process");
    }
  }

  // Immediate receipt ack; the in-process turn can take a while.
  await message.react("👀").catch(() => {});
  if (!deps.workspaceEnabled) {
    await deps.runInProcess(message, text, {});
    return;
  }
  const reply = await deps.runInProcess(message, text, { notice: OFFLINE_NOTICE });
  deps.link.recordOffline(text, reply ?? "(no reply)");
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

/** One DM, live or caught up: task replies and needs_input answers consume it first; otherwise an
 *  owner DM goes to the owner-DM handler. Every owner DM advances the cursor, whichever branch took it. */
export async function routeDirectMessage<T extends { id: string }>(
  message: T,
  deps: {
    isOwner: boolean;
    preChecks: Array<(message: T) => Promise<boolean>>;
    handleOwner: (message: T) => Promise<void>;
    cursor: DmCursor;
    onOwnerDm?: (id: string) => void;
  },
): Promise<void> {
  if (deps.isOwner) deps.onOwnerDm?.(message.id);
  try {
    for (const check of deps.preChecks) if (await check(message)) return;
    if (deps.isOwner) await deps.handleOwner(message);
  } finally {
    if (deps.isOwner) advanceCursor(deps.cursor, message.id);
  }
}
