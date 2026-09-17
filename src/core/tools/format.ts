// Plain-text rendering shared across tool entries — ports formatMessageRow/formatModCaseLine
// from the old moderation/executor.ts. Output still carries the u:/c:/t:/msg: tokens a surface's
// PlatformRenderer expands (contracts.ts §6); the core never renders them itself.
import type { DiscordMessageResult } from "./hosts.ts";
import type { KnownUsersSink } from "./pendingSink.ts";
import "./pendingSink.ts";

export function formatMessageRow(row: DiscordMessageResult & { deletedAt?: number | null; isAutomod?: boolean; replyToContent?: string | null; replyToAuthorId?: string | null }): string {
  const seconds = Math.floor(row.createdAt / 1000);
  let line = `msg:${row.channelId}/${row.discordId} t:${seconds}:R u:${row.authorId}: ${row.content}`;
  if (row.replyToId) {
    if (row.replyToContent != null && row.replyToAuthorId != null) {
      line += `\n  [replying to u:${row.replyToAuthorId}: ${row.replyToContent}]`;
    } else {
      line += `\n  [replying to: msg:${row.channelId}/${row.replyToId}]`;
    }
  }
  if (row.deletedAt) line += " [DELETED]";
  if (row.isAutomod) line += " [AUTOMOD]";
  return line;
}

export function formatMessageRows(rows: DiscordMessageResult[], emptyReason: string): string {
  if (rows.length === 0) return `(no results for ${emptyReason} — nothing matches these filters; only different filters will change this, not a different limit)`;
  return rows.map((r) => formatMessageRow(r)).join("\n");
}

/** Ports extractUsers (old moderation/executor.ts) for the message-row case. */
export function collectKnownUsersFromRows(rows: DiscordMessageResult[], sink?: KnownUsersSink): void {
  if (!sink) return;
  for (const row of rows) sink.add(row.authorId, { username: row.authorUsername, displayName: row.authorDisplayName });
}

export interface ModCaseLike {
  caseId: string;
  action: string;
  userId: string;
  userTag: string;
  actionTime: number;
  executorId?: string;
  reason?: string;
}

export function formatModCaseLine(c: ModCaseLike): string {
  const parts = [`case:${c.caseId} [${c.action}] subject: u:${c.userId} (${c.userTag}) t:${c.actionTime}`];
  if (c.executorId) parts.push(`  executor: u:${c.executorId}`);
  if (c.reason) parts.push(`  reason: ${c.reason}`);
  return parts.join("\n");
}
