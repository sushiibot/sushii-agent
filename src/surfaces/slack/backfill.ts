import type { Database } from "bun:sqlite";
import { getLogger } from "../../logger.ts";
import { getSlackSyncState, setSlackSyncState, upsertSlackMessage } from "../../db/slackMessages.ts";
import { slackMessageToRow, type SlackMessageEvent } from "./ingest.ts";

const defaultLog = getLogger("surfaces/slack/backfill");

interface SlackChannel {
  id?: string;
  is_member?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  name?: string;
  [k: string]: unknown;
}

interface SlackListResponse {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

interface SlackHistoryResponse {
  messages?: SlackMessageEvent[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

/** The read surface backfill needs — narrowed from `WebClient` so a fake client is trivial to
 *  construct in tests. `app.client` structurally satisfies this. */
export interface SlackReadClient {
  conversations: {
    list(args: { types?: string; limit?: number; cursor?: string; exclude_archived?: boolean }): Promise<SlackListResponse>;
    history(args: {
      channel: string;
      limit?: number;
      cursor?: string;
      oldest?: string;
      latest?: string;
      inclusive?: boolean;
    }): Promise<SlackHistoryResponse>;
    replies(args: { channel: string; ts: string; limit?: number; cursor?: string }): Promise<SlackHistoryResponse>;
  };
}

export interface BackfillDeps {
  log?: ReturnType<typeof getLogger>;
  /** Inter-page delay to stay under the method rate limit; the WebClient still auto-retries 429s
   *  (honoring Retry-After) on top of this. */
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tsNum = (ts: string | undefined) => (ts ? parseFloat(ts) : NaN);
const olderTs = (a: string | undefined, b: string) => (!a || tsNum(b) < tsNum(a) ? b : a);
const newerTs = (a: string | undefined, b: string) => (!a || tsNum(b) > tsNum(a) ? b : a);

/** Page `conversations.history` newest→oldest within the given bounds (both inclusive), invoking
 *  `onMessage` per message and `onPage` with each page's oldest ts (for resumable cursor persistence).
 *  Returns the min/max ts observed across the whole crawl. */
async function crawlHistory(
  client: SlackReadClient,
  channel: string,
  bounds: { oldest?: string; latest?: string },
  handlers: { onMessage: (msg: SlackMessageEvent) => Promise<void>; onPage?: (pageOldestTs: string) => void },
  delayMs: number,
): Promise<{ minTs?: string; maxTs?: string }> {
  let cursor: string | undefined;
  let minTs: string | undefined;
  let maxTs: string | undefined;
  do {
    const res = await client.conversations.history({
      channel,
      limit: 200,
      cursor,
      oldest: bounds.oldest,
      latest: bounds.latest,
      inclusive: true,
    });
    let pageOldest: string | undefined;
    for (const msg of res.messages ?? []) {
      await handlers.onMessage(msg);
      if (msg.ts) {
        minTs = olderTs(minTs, msg.ts);
        maxTs = newerTs(maxTs, msg.ts);
        pageOldest = olderTs(pageOldest, msg.ts);
      }
    }
    if (pageOldest && handlers.onPage) handlers.onPage(pageOldest);
    cursor = res.response_metadata?.next_cursor || undefined;
    if (cursor) await sleep(delayMs);
  } while (cursor);
  return { minTs, maxTs };
}

/** Fetch every reply of a thread and upsert them (idempotent; the parent reappears harmlessly). */
async function backfillThread(client: SlackReadClient, db: Database, channel: string, ts: string, delayMs: number): Promise<void> {
  let cursor: string | undefined;
  do {
    const res = await client.conversations.replies({ channel, ts, limit: 200, cursor });
    for (const msg of res.messages ?? []) {
      if (msg.ts) upsertSlackMessage(db, slackMessageToRow(channel, msg, msg, Date.now()));
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (cursor) await sleep(delayMs);
  } while (cursor);
}

async function backfillChannel(
  client: SlackReadClient,
  db: Database,
  channel: string,
  log: ReturnType<typeof getLogger>,
  delayMs: number,
): Promise<void> {
  const state = getSlackSyncState(db, channel);
  let newest = state?.latestSeen ?? undefined;
  let oldest = state?.oldestBackfilled ?? undefined;

  const onMessage = async (msg: SlackMessageEvent) => {
    if (!msg.ts) return;
    upsertSlackMessage(db, slackMessageToRow(channel, msg, msg, Date.now()));
    newest = newerTs(newest, msg.ts);
    if ((typeof msg.reply_count === "number" ? msg.reply_count : 0) > 0) {
      await backfillThread(client, db, channel, msg.ts, delayMs);
    }
  };

  // Forward catch-up: anything newer than the last run's high-water mark (missed while offline).
  if (state?.latestSeen) {
    await crawlHistory(client, channel, { oldest: state.latestSeen }, { onMessage }, delayMs);
  }

  // Backward historical crawl — the primary pass. Resumes from the oldest ts reached so far and
  // persists it per page so a restart continues older rather than re-crawling from the top.
  await crawlHistory(
    client,
    channel,
    { latest: state?.oldestBackfilled ?? undefined },
    {
      onMessage,
      onPage: (pageOldest) => {
        oldest = olderTs(oldest, pageOldest);
        setSlackSyncState(db, channel, { oldestBackfilled: oldest });
      },
    },
    delayMs,
  );

  if (newest) setSlackSyncState(db, channel, { latestSeen: newest });
  log.debug({ channel, oldest, newest }, "slack channel backfill pass complete");
}

/** Enumerate the conversations the bot can read and archive their history. Phase 1 does not
 *  auto-join public channels — only conversations the bot is already a member of (plus DMs/mpims)
 *  are crawled, so no `channels:join` scope is needed. Idempotent; safe to run on every startup. */
export async function backfillWorkspace(client: SlackReadClient, db: Database, deps: BackfillDeps = {}): Promise<void> {
  const log = deps.log ?? defaultLog;
  const delayMs = deps.delayMs ?? 1200;

  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: "public_channel,private_channel,im,mpim",
      limit: 200,
      cursor,
      exclude_archived: false,
    });
    for (const c of res.channels ?? []) {
      if (c.id && (c.is_member || c.is_im || c.is_mpim)) channels.push(c);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (cursor) await sleep(delayMs);
  } while (cursor);

  log.info({ count: channels.length }, "slack backfill starting");
  for (const c of channels) {
    try {
      await backfillChannel(client, db, c.id!, log, delayMs);
    } catch (err) {
      // One unreadable channel must not abort the whole backfill.
      log.error({ err, channel: c.id }, "slack channel backfill failed");
    }
    await sleep(delayMs);
  }
  log.info("slack backfill complete");
}
