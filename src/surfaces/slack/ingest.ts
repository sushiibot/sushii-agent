import type { App } from "@slack/bolt";
import type { Database } from "bun:sqlite";
import { getLogger } from "../../logger.ts";
import {
  markSlackMessageDeleted,
  upsertSlackMessage,
  type SlackMessageRow,
} from "../../db/slackMessages.ts";
import { backfillWorkspace, type SlackReadClient } from "./backfill.ts";

const defaultLog = getLogger("surfaces/slack/ingest");

/** Loose view of a Slack `message` event — Bolt's union is broad, and ingestion keeps everything via
 *  `rawJson` regardless, so the mapper reads fields defensively rather than over-typing the payload. */
export interface SlackMessageEvent {
  type: "message";
  channel?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  blocks?: unknown;
  files?: unknown;
  team?: string;
  edited?: { ts?: string };
  deleted_ts?: string;
  message?: SlackMessageEvent;
  previous_message?: SlackMessageEvent;
  [k: string]: unknown;
}

/** Slack ts ("1609459200.000400", seconds w/ microsecond suffix) → ms epoch. */
export function slackTsToMs(ts: string): number {
  return Math.round(parseFloat(ts) * 1000);
}

function jsonOrNull(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v);
}

/** Map a content-bearing message object to a row. For a `message_changed` event this is
 *  `event.message` (so the row keys on the real message ts and carries its true subtype, not the
 *  `message_changed` envelope); for backfill it is a bare `conversations.history` message. Throws if
 *  it lacks the (channel, ts) identity — the caller logs the raw payload rather than dropping it. */
export function slackMessageToRow(channel: string | undefined, msg: SlackMessageEvent, raw: unknown, now: number): SlackMessageRow {
  if (!channel || !msg.ts) {
    throw new Error(`slack message event missing channel/ts: channel=${channel} ts=${msg.ts}`);
  }
  return {
    channel,
    ts: msg.ts,
    threadTs: msg.thread_ts ?? null,
    user: msg.user ?? null,
    botId: msg.bot_id ?? null,
    subtype: msg.subtype ?? null,
    text: msg.text ?? "",
    blocks: jsonOrNull(msg.blocks),
    files: jsonOrNull(msg.files),
    team: msg.team ?? null,
    editedTs: msg.edited?.ts ?? null,
    createdAt: slackTsToMs(msg.ts),
    rawJson: JSON.stringify(raw),
    ingestedAt: now,
  };
}

export function slackEventToRow(event: SlackMessageEvent, now: number): SlackMessageRow {
  if (event.subtype === "message_changed" && event.message) {
    return slackMessageToRow(event.channel, event.message, event, now);
  }
  return slackMessageToRow(event.channel, event, event, now);
}

/** Tombstone row for a `message_deleted` event. Content is populated from `previous_message` so a
 *  never-before-seen deleted message still archives its text; on an existing row only the tombstone
 *  is applied (see `markSlackMessageDeleted`). */
export function slackDeleteToRow(event: SlackMessageEvent, now: number): SlackMessageRow & { deletedAt: number } {
  const prev: SlackMessageEvent = event.previous_message ?? ({} as SlackMessageEvent);
  const ts = event.deleted_ts ?? prev.ts;
  if (!event.channel || !ts) {
    throw new Error(`slack message_deleted missing channel/deleted_ts: channel=${event.channel} ts=${ts}`);
  }
  return {
    channel: event.channel,
    ts,
    threadTs: prev.thread_ts ?? null,
    user: prev.user ?? null,
    botId: prev.bot_id ?? null,
    subtype: prev.subtype ?? null,
    text: prev.text ?? "",
    blocks: jsonOrNull(prev.blocks),
    files: jsonOrNull(prev.files),
    team: prev.team ?? null,
    editedTs: prev.edited?.ts ?? null,
    createdAt: slackTsToMs(ts),
    rawJson: JSON.stringify(event),
    ingestedAt: now,
    deletedAt: now,
  };
}

export interface IngestDeps {
  db: Database;
  log?: ReturnType<typeof getLogger>;
}

/** Register the durable-capture listener on an unstarted app and kick a one-shot backfill. The
 *  caller starts the app afterwards. Every failure is isolated — an ingest throw logs the raw
 *  payload, and backfill runs fire-and-forget so it can never block or crash the socket. */
export function startSlackIngestion(app: App, deps: IngestDeps): void {
  const log = deps.log ?? defaultLog;
  const { db } = deps;

  app.event("message", async ({ event }) => {
    const e = event as unknown as SlackMessageEvent;
    try {
      if (e.subtype === "message_deleted") {
        markSlackMessageDeleted(db, slackDeleteToRow(e, Date.now()));
      } else {
        upsertSlackMessage(db, slackEventToRow(e, Date.now()));
      }
    } catch (err) {
      log.error({ err, raw: e }, "failed to ingest slack message event");
    }
  });

  app.error(async (err) => {
    log.error({ err }, "slack bolt error");
  });

  // app.client (WebClient) structurally provides the read methods; the narrow SlackReadClient exists
  // so tests need only a tiny fake, and the cast bridges the two at this single boundary.
  backfillWorkspace(app.client as unknown as SlackReadClient, db, { log }).catch((err) => {
    log.error({ err }, "slack backfill failed");
  });
}
