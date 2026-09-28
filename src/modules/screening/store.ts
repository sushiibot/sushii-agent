import type { Database } from "bun:sqlite";
import { and, desc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { screeningVerdicts } from "../../db/schema.ts";

export type VerdictRow = typeof screeningVerdicts.$inferSelect;
export type NewVerdict = typeof screeningVerdicts.$inferInsert;

export interface JudgedLine {
  author: string;
  text: string;
}

export interface Judged {
  context: JudgedLine[];
  target: JudgedLine[];
}

function orm(db: Database) {
  return drizzle({ client: db, schema: { screeningVerdicts } });
}

export function insertVerdict(db: Database, v: NewVerdict): VerdictRow {
  return orm(db).insert(screeningVerdicts).values(v).returning().get();
}

export function getVerdict(db: Database, id: number): VerdictRow | undefined {
  return orm(db).select().from(screeningVerdicts).where(eq(screeningVerdicts.id, id)).get();
}

export function hasPfpVerdict(db: Database, userId: string, avatarHash: string): boolean {
  const row = orm(db)
    .select({ id: screeningVerdicts.id })
    .from(screeningVerdicts)
    .where(and(eq(screeningVerdicts.kind, "pfp"), eq(screeningVerdicts.userId, userId), eq(screeningVerdicts.avatarHash, avatarHash)))
    .get();
  return row !== undefined;
}

export function hasImageVerdict(db: Database, guildId: string, imageKey: string): boolean {
  const row = orm(db)
    .select({ id: screeningVerdicts.id })
    .from(screeningVerdicts)
    .where(and(eq(screeningVerdicts.kind, "image"), eq(screeningVerdicts.guildId, guildId), eq(screeningVerdicts.imageKey, imageKey)))
    .get();
  return row !== undefined;
}

/** The user's latest still-open text post since `since`, so a burst of messages edits one post
 *  instead of posting once per message. */
export function openTextPost(db: Database, guildId: string, userId: string, since: number): VerdictRow | undefined {
  return orm(db)
    .select()
    .from(screeningVerdicts)
    .where(
      and(
        eq(screeningVerdicts.kind, "text"),
        eq(screeningVerdicts.guildId, guildId),
        eq(screeningVerdicts.userId, userId),
        gte(screeningVerdicts.createdAt, since),
        isNull(screeningVerdicts.outcome),
        isNotNull(screeningVerdicts.postMessageId),
      ),
    )
    .orderBy(desc(screeningVerdicts.createdAt))
    .get();
}

export function setPost(db: Database, id: number, postChannelId: string, postMessageId: string): void {
  orm(db).update(screeningVerdicts).set({ postChannelId, postMessageId }).where(eq(screeningVerdicts.id, id)).run();
}

export function setIgnored(db: Database, postMessageId: string, by: string, at: number): VerdictRow[] {
  return orm(db)
    .update(screeningVerdicts)
    .set({ outcome: "ignored", outcomeBy: by, outcomeAt: at, outcomeAction: null })
    .where(and(eq(screeningVerdicts.postMessageId, postMessageId), isNull(screeningVerdicts.outcome)))
    .returning()
    .all();
}

/** A mod action overrides an earlier Ignore: the ban is the stronger signal. */
export function setActioned(
  db: Database,
  guildId: string,
  userId: string,
  since: number,
  by: string | null,
  action: string,
  at: number,
): VerdictRow[] {
  return orm(db)
    .update(screeningVerdicts)
    .set({ outcome: "actioned", outcomeBy: by, outcomeAction: action, outcomeAt: at })
    .where(
      and(
        eq(screeningVerdicts.guildId, guildId),
        eq(screeningVerdicts.userId, userId),
        eq(screeningVerdicts.flagged, 1),
        gte(screeningVerdicts.createdAt, since),
        or(isNull(screeningVerdicts.outcome), eq(screeningVerdicts.outcome, "ignored")),
      ),
    )
    .returning()
    .all();
}

export function markMessageDeleted(db: Database, messageIds: string[]): VerdictRow[] {
  if (messageIds.length === 0) return [];
  return orm(db)
    .update(screeningVerdicts)
    .set({ messageDeleted: 1 })
    .where(and(inArray(screeningVerdicts.messageId, messageIds), eq(screeningVerdicts.flagged, 1)))
    .returning()
    .all();
}

/** The row a post currently renders: the newest verdict attached to that post. */
export function latestForPost(db: Database, postMessageId: string): VerdictRow | undefined {
  return orm(db)
    .select()
    .from(screeningVerdicts)
    .where(eq(screeningVerdicts.postMessageId, postMessageId))
    .orderBy(desc(screeningVerdicts.id))
    .get();
}
