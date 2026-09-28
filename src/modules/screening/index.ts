import type { Database } from "bun:sqlite";
import type { ContainerBuilder } from "discord.js";
import { resolvedModules, type GuildConfig } from "../../guildConfig.ts";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { getLogger } from "../../logger.ts";
import { tracer } from "../../telemetry.ts";
import { classifyImage, classifyText, type ImageVerdict, type StateMessage, type TextVerdict } from "./classify.ts";
import { extractImageLinks } from "./images.ts";
import { buildVerdictPost, topRule } from "./render.ts";
import { SCREENING_RULES, type ScreeningRule } from "./rules.ts";
import {
  automodSummary,
  hasImageVerdict,
  hasPfpVerdict,
  insertVerdict,
  latestForPost,
  markMessageDeleted,
  openTextPost,
  postedForUser,
  setActioned,
  setIgnored,
  setPost,
  type JudgedLine,
  type NewVerdict,
  type VerdictRow,
} from "./store.ts";

export { SCREENING_IGNORE_PREFIX } from "./render.ts";

const logger = getLogger("screening");

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_REVIEW_THRESHOLD = 0.35;
const CONTEXT_MESSAGES = 20;
const TARGET_LINES = 5;
const CONTEXT_LINES = 2;
const STATE_TEXT_MAX = 500;
/** A burst of flagged messages from one user edits the same post instead of posting per message. */
const BURST_MS = 10 * 60 * 1000;

/** The subset of a discord.js Message that screening reads — kept narrow so tests can build one. */
export interface ScreenedMessage {
  id: string;
  guildId: string;
  channelId: string;
  createdTimestamp: number;
  content: string;
  embeds: readonly { image?: { proxyURL?: string | null } | null; thumbnail?: { proxyURL?: string | null } | null }[];
  author: { id: string; bot: boolean; avatar: string | null };
  member: {
    joinedTimestamp: number | null;
    avatar: string | null;
    roleIds: readonly string[];
    avatarUrl: string;
  } | null;
}

export interface ScreeningDeps {
  db: Database;
  now?: () => number;
  classifyText?: (messages: StateMessage[], rules: readonly ScreeningRule[]) => Promise<TextVerdict>;
  classifyImage?: (url: string) => Promise<ImageVerdict>;
  post: (channelId: string, container: ContainerBuilder) => Promise<string>;
  edit: (channelId: string, messageId: string, container: ContainerBuilder) => Promise<void>;
}

/** One span per check; the verdict log line inside it carries the trace id via the logger mixin. */
function withCheckSpan<T>(kind: string, message: { guildId: string; author: { id: string } }, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(
    "screening.check",
    { attributes: { "screening.kind": kind, "discord.guild_id": message.guildId, "discord.user_id": message.author.id } },
    async (span) => {
      try {
        return await fn();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Inserts and logs the verdict. The footer shows `#<id>`, so a pasted id finds this log line in
 *  Loki (and its trace) with the full scores and judged text. */
function saveVerdict(db: Database, v: NewVerdict): VerdictRow {
  const row = insertVerdict(db, v);
  const judged = row.judged ? (JSON.parse(row.judged) as { target?: JudgedLine[] }) : null;
  trace.getActiveSpan()?.setAttributes({
    "screening.verdict_id": row.id,
    "screening.flagged": row.flagged === 1,
    ...(row.topRule ? { "screening.top_rule": row.topRule } : {}),
    ...(row.cost != null ? { "screening.cost": row.cost } : {}),
  });
  logger.info(
    {
      verdictId: row.id,
      kind: row.kind,
      guildId: row.guildId,
      channelId: row.channelId,
      userId: row.userId,
      messageId: row.messageId,
      flagged: row.flagged === 1,
      topRule: row.topRule,
      scores: row.scores ? JSON.parse(row.scores) : null,
      categories: row.categories ? JSON.parse(row.categories) : null,
      ordinal: row.ordinal,
      model: row.model,
      cost: row.cost,
      error: row.error,
      sourceUrl: row.sourceUrl,
      target: judged?.target?.map((l) => `${l.author}: ${l.text.slice(0, 300)}`),
    },
    "screening verdict",
  );
  return row;
}

const inflight = new Set<string>();
/** Text checks run one at a time per user: concurrent checks would all miss each other's open post
 *  and a fast burst would get one post per message. */
const textChains = new Map<string, Promise<void>>();

function serializeText(key: string, run: () => Promise<void>): Promise<void> {
  const next = (textChains.get(key) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => {});
  textChains.set(key, settled);
  void settled.then(() => {
    if (textChains.get(key) === settled) textChains.delete(key);
  });
  return next;
}

export function screeningEnabled(cfg: GuildConfig): boolean {
  return resolvedModules(cfg).includes("screening");
}

function logChannelFor(cfg: GuildConfig): string | undefined {
  return cfg.screening?.logChannelId ?? cfg.alertsChannelId;
}

function thresholdFor(cfg: GuildConfig): number {
  return cfg.screening?.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
}

function rulesFor(cfg: GuildConfig): readonly ScreeningRule[] {
  const ids = cfg.screening?.rules;
  return ids ? SCREENING_RULES.filter((r) => ids.includes(r.id)) : SCREENING_RULES;
}

/** Whether this message's author is still inside the screening window. Rejoining resets
 *  joinedTimestamp, so a rejoiner is screened again. */
export function isScreenable(message: ScreenedMessage, cfg: GuildConfig, now: number): boolean {
  if (message.author.bot || !message.member?.joinedTimestamp) return false;
  const immune = new Set([...(cfg.modImmuneRoleIds ?? []), ...cfg.allowedRoles]);
  if (message.member.roleIds.some((id) => immune.has(id))) return false;
  const windowDays = cfg.screening?.windowDays ?? DEFAULT_WINDOW_DAYS;
  return now - message.member.joinedTimestamp < windowDays * DAY_MS;
}

/** Entry point from MessageCreate/MessageUpdate: runs the text, profile-picture and image-link
 *  checks for a new member. Never throws — screening must not affect the rest of the handler. */
export async function screenMessage(
  message: ScreenedMessage,
  cfg: GuildConfig,
  deps: ScreeningDeps,
  opts: { skipText?: boolean } = {},
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  if (!screeningEnabled(cfg) || !isScreenable(message, cfg, now)) return;
  const results = await Promise.allSettled([
    opts.skipText
      ? Promise.resolve()
      : serializeText(`${message.guildId}:${message.author.id}`, () => withCheckSpan("text", message, () => screenText(message, cfg, deps, now))),
    withCheckSpan("pfp", message, () => screenAvatar(message, cfg, deps, now)),
    withCheckSpan("image", message, () => screenImages(message, cfg, deps, now)),
  ]);
  for (const r of results) {
    if (r.status === "rejected") logger.warn({ err: r.reason, guildId: message.guildId, messageId: message.id }, "screening check failed");
  }
}

interface CachedRow {
  discord_id: string;
  author_id: string;
  author_username: string | null;
  author_display_name: string | null;
  content: string;
}

function authorName(r: CachedRow): string {
  return r.author_display_name ?? r.author_username ?? r.author_id;
}

async function screenText(message: ScreenedMessage, cfg: GuildConfig, deps: ScreeningDeps, now: number): Promise<void> {
  if (!message.content.trim()) return;
  const rows = deps.db
    .query<CachedRow, [string, string, number, number]>(
      `SELECT discord_id, author_id, author_username, author_display_name, content FROM messages
       WHERE guild_id = ? AND channel_id = ? AND created_at <= ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(message.guildId, message.channelId, message.createdTimestamp, CONTEXT_MESSAGES)
    .reverse();
  const userId = message.author.id;
  if (!rows.some((r) => r.discord_id === message.id)) return;

  const joinedAt = message.member!.joinedTimestamp!;
  const ordinal =
    deps.db
      .query<{ n: number }, [string, string, number, number]>(
        `SELECT COUNT(*) AS n FROM messages WHERE guild_id = ? AND author_id = ? AND created_at >= ? AND created_at <= ?`,
      )
      .get(message.guildId, userId, joinedAt, message.createdTimestamp)?.n ?? null;

  const state: StateMessage[] = rows.map((r, i) => ({
    id: `m${i + 1}`,
    author: authorName(r),
    target: r.author_id === userId,
    text: r.content.slice(0, STATE_TEXT_MAX),
  }));

  const rules = rulesFor(cfg);
  const base: NewVerdict = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId,
    messageId: message.id,
    kind: "text",
    joinedAt,
    ordinal,
    judged: JSON.stringify(judgedLines(rows, userId)),
    createdAt: now,
  };

  let verdict: TextVerdict;
  try {
    verdict = await (deps.classifyText ?? classifyText)(state, rules);
  } catch (err) {
    saveVerdict(deps.db, { ...base, error: String(err) });
    throw err;
  }
  const threshold = thresholdFor(cfg);
  const flagged = Object.values(verdict.scores).some((p) => p >= threshold);
  const row = saveVerdict(deps.db, {
    ...base,
    scores: JSON.stringify(verdict.scores),
    topRule: topRule(verdict.scores),
    flagged: flagged ? 1 : 0,
    model: verdict.model,
    cost: verdict.cost,
  });
  if (!flagged) return;

  const open = openTextPost(deps.db, message.guildId, userId, now - BURST_MS);
  if (open?.postChannelId && open.postMessageId) {
    setPost(deps.db, row.id, open.postChannelId, open.postMessageId);
    await deps.edit(open.postChannelId, open.postMessageId, renderPost(deps.db, { ...row, postMessageId: open.postMessageId }, cfg));
    return;
  }
  await postVerdict(row, cfg, deps);
}

/** Up to TARGET_LINES of the target's messages, plus the CONTEXT_LINES other messages just before
 *  the first of them. */
export function judgedLines(rows: CachedRow[], userId: string): { context: JudgedLine[]; target: JudgedLine[] } {
  const targetIdx = rows.flatMap((r, i) => (r.author_id === userId ? [i] : [])).slice(-TARGET_LINES);
  if (targetIdx.length === 0) return { context: [], target: [] };
  const first = targetIdx[0]!;
  const context = rows
    .slice(0, first)
    .filter((r) => r.author_id !== userId)
    .slice(-CONTEXT_LINES)
    .map((r) => ({ author: authorName(r), text: r.content }));
  const target = targetIdx.map((i) => ({ author: authorName(rows[i]!), text: rows[i]!.content }));
  return { context, target };
}

async function screenAvatar(message: ScreenedMessage, cfg: GuildConfig, deps: ScreeningDeps, now: number): Promise<void> {
  const member = message.member!;
  const hash = member.avatar ?? message.author.avatar;
  if (!hash) return;
  const key = `pfp:${message.author.id}:${hash}`;
  if (inflight.has(key) || hasPfpVerdict(deps.db, message.author.id, hash)) return;
  inflight.add(key);
  try {
    await screenImage(message, cfg, deps, now, { kind: "pfp", url: member.avatarUrl, avatarHash: hash });
  } finally {
    inflight.delete(key);
  }
}

async function screenImages(message: ScreenedMessage, cfg: GuildConfig, deps: ScreeningDeps, now: number): Promise<void> {
  for (const link of extractImageLinks(message.content, message.embeds)) {
    const key = `img:${message.guildId}:${link.key}`;
    if (inflight.has(key) || hasImageVerdict(deps.db, message.guildId, link.key)) continue;
    inflight.add(key);
    try {
      await screenImage(message, cfg, deps, now, { kind: "image", url: link.url, imageKey: link.key });
    } finally {
      inflight.delete(key);
    }
  }
}

async function screenImage(
  message: ScreenedMessage,
  cfg: GuildConfig,
  deps: ScreeningDeps,
  now: number,
  target: { kind: "pfp" | "image"; url: string; avatarHash?: string; imageKey?: string },
): Promise<void> {
  const base: NewVerdict = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    messageId: message.id,
    kind: target.kind,
    avatarHash: target.avatarHash,
    imageKey: target.imageKey,
    sourceUrl: target.url,
    joinedAt: message.member?.joinedTimestamp ?? null,
    createdAt: now,
  };
  let verdict: ImageVerdict;
  try {
    verdict = await (deps.classifyImage ?? classifyImage)(target.url);
  } catch (err) {
    // Recorded so an expired/unreachable link isn't retried on every edit.
    saveVerdict(deps.db, { ...base, error: String(err) });
    throw err;
  }
  const row = saveVerdict(deps.db, {
    ...base,
    scores: JSON.stringify({ unsafe: verdict.unsafe ? 1 : 0 }),
    categories: JSON.stringify(verdict.categories),
    flagged: verdict.unsafe ? 1 : 0,
    model: verdict.model,
    cost: verdict.cost,
  });
  if (verdict.unsafe) await postVerdict(row, cfg, deps);
}

/** Posts show the user's AutoMod blocks since joining, so mods see one combined picture instead of
 *  a screening flag and AutoMod alerts that don't know about each other. */
function renderPost(db: Database, row: VerdictRow, cfg: GuildConfig): ContainerBuilder {
  return buildVerdictPost(row, thresholdFor(cfg), automodSummary(db, row.guildId, row.userId, row.joinedAt ?? 0));
}

async function postVerdict(row: VerdictRow, cfg: GuildConfig, deps: ScreeningDeps): Promise<void> {
  const channelId = logChannelFor(cfg);
  if (!channelId) return;
  const postId = await deps.post(channelId, renderPost(deps.db, row, cfg));
  setPost(deps.db, row.id, channelId, postId);
}

async function refreshPosts(rows: VerdictRow[], cfg: GuildConfig, deps: ScreeningDeps): Promise<void> {
  const posts = new Map<string, string>();
  for (const r of rows) if (r.postChannelId && r.postMessageId) posts.set(r.postMessageId, r.postChannelId);
  for (const [postMessageId, postChannelId] of posts) {
    const latest = latestForPost(deps.db, postMessageId);
    if (!latest) continue;
    await deps.edit(postChannelId, postMessageId, renderPost(deps.db, latest, cfg)).catch((err) => {
      logger.warn({ err, postMessageId }, "failed to refresh screening post");
    });
  }
}

/** Ignore button: marks every verdict on that post as a false positive. Returns the re-rendered
 *  post, or null when there is nothing left to ignore. */
export function ignorePost(postMessageId: string, by: string, cfg: GuildConfig, deps: Pick<ScreeningDeps, "db" | "now">): ContainerBuilder | null {
  const changed = setIgnored(deps.db, postMessageId, by, deps.now?.() ?? Date.now());
  if (changed.length === 0) return null;
  const latest = latestForPost(deps.db, postMessageId);
  return latest ? renderPost(deps.db, latest, cfg) : null;
}

/** A ban/kick/timeout of a flagged user inside the window marks their verdicts as true positives. */
export async function recordModAction(
  guildId: string,
  userId: string,
  action: string,
  by: string | null,
  cfg: GuildConfig,
  deps: ScreeningDeps,
): Promise<void> {
  if (!screeningEnabled(cfg)) return;
  const now = deps.now?.() ?? Date.now();
  const since = now - (cfg.screening?.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY_MS;
  const rows = setActioned(deps.db, guildId, userId, since, by, action, now);
  if (rows.length > 0) {
    logger.info({ guildId, userId, action, verdicts: rows.length }, "screening verdicts actioned");
    await refreshPosts(rows, cfg, deps);
  }
}

export async function recordMessagesDeleted(messageIds: string[], cfg: GuildConfig, deps: ScreeningDeps): Promise<void> {
  if (!screeningEnabled(cfg)) return;
  const rows = markMessageDeleted(deps.db, messageIds);
  if (rows.length > 0) await refreshPosts(rows, cfg, deps);
}

export interface AutomodBlock {
  guildId: string;
  userId: string;
  channelId: string | null;
  /** Blocked messages never exist, so this is the alert message id when there is one. */
  messageId: string | null;
  ruleName: string;
  content: string;
  matchedKeyword: string | null;
  authorName: string;
  member: { joinedTimestamp: number | null; roleIds: readonly string[] } | null;
}

/** An AutoMod block by a new member: recorded, scored by Jev without posting (known-bad samples
 *  for measuring recall), and shown on the user's existing flag posts. Never posts on its own —
 *  AutoMod already alerted the mods. */
export async function recordAutomodBlock(block: AutomodBlock, cfg: GuildConfig, deps: ScreeningDeps): Promise<void> {
  if (!screeningEnabled(cfg) || !block.member?.joinedTimestamp) return;
  await withCheckSpan("automod", { guildId: block.guildId, author: { id: block.userId } }, () => recordAutomodBlockInner(block, cfg, deps));
}

async function recordAutomodBlockInner(block: AutomodBlock, cfg: GuildConfig, deps: ScreeningDeps): Promise<void> {
  if (!block.member?.joinedTimestamp) return;
  const now = deps.now?.() ?? Date.now();
  const screened: ScreenedMessage = {
    id: block.messageId ?? "",
    guildId: block.guildId,
    channelId: block.channelId ?? "",
    createdTimestamp: now,
    content: block.content,
    embeds: [],
    author: { id: block.userId, bot: false, avatar: null },
    member: { joinedTimestamp: block.member.joinedTimestamp, avatar: null, roleIds: block.member.roleIds, avatarUrl: "" },
  };
  if (!isScreenable(screened, cfg, now)) return;

  let scores: TextVerdict | null = null;
  let error: string | null = null;
  if (block.content.trim()) {
    try {
      scores = await (deps.classifyText ?? classifyText)(
        [{ id: "m1", author: block.authorName, target: true, text: block.content.slice(0, STATE_TEXT_MAX) }],
        rulesFor(cfg),
      );
    } catch (err) {
      error = String(err);
      logger.warn({ err, guildId: block.guildId }, "screening automod scoring failed");
    }
  }
  saveVerdict(deps.db, {
    guildId: block.guildId,
    channelId: block.channelId ?? "",
    userId: block.userId,
    messageId: block.messageId ?? `automod:${now}`,
    kind: "automod",
    scores: scores ? JSON.stringify(scores.scores) : null,
    topRule: scores ? topRule(scores.scores) : null,
    categories: JSON.stringify([block.ruleName]),
    flagged: 0,
    joinedAt: block.member.joinedTimestamp,
    model: scores?.model ?? null,
    cost: scores?.cost ?? null,
    judged: JSON.stringify({
      context: [],
      target: [{ author: block.authorName, text: block.content }],
      automod: { rule: block.ruleName, keyword: block.matchedKeyword },
    }),
    error,
    createdAt: now,
  });
  await refreshPosts(postedForUser(deps.db, block.guildId, block.userId, block.member.joinedTimestamp), cfg, deps);
}
