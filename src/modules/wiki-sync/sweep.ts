import type { Client } from "discord.js";
import { join } from "node:path";
import { config } from "../../config.ts";
import { getDb } from "../../db/index.ts";
import { getLogger } from "../../logger.ts";
import { getUnprocessedMessages, getWikiSyncWatermark, setWikiSyncWatermark } from "../../db/wikiSync.ts";
import { openWikiRepo } from "./git.ts";
import { writeMessageInbox } from "./inbox.ts";
import { postSyncStatus } from "./notify.ts";
import { runWikiSyncSession } from "./piSession.ts";
import { buildSweepTriggerPrompt } from "./prompt.ts";

const logger = getLogger("wiki-sync:sweep");

/** Guards against the cron tick and an on-demand /wiki-sync command racing on the same working tree. */
const inFlight = new Set<string>();

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface SweepResult {
  ran: boolean;
  reason?: string;
  commitSha?: string | null;
}

export async function runWikiSyncSweep(guildId: string, client: Client): Promise<SweepResult> {
  if (inFlight.has(guildId)) {
    return { ran: false, reason: "a sweep is already running for this guild" };
  }
  inFlight.add(guildId);

  const db = getDb();
  try {
    // Floor against the message-retention window so a stale/missing watermark (first run,
    // long-dead bot) can't try to scan further back than the DB actually has.
    const floor = Date.now() - RETENTION_MS;
    const watermark = Math.max(getWikiSyncWatermark(db, guildId), floor);

    const messages = getUnprocessedMessages(db, guildId, watermark, config.wikiSyncMaxMessagesPerSweep);
    if (messages.length === 0) {
      setWikiSyncWatermark(db, guildId, Date.now());
      return { ran: true, reason: "no new messages" };
    }

    const repo = await openWikiRepo(guildId);
    // Sibling of the repo checkout, outside its git working tree entirely — see inbox.ts.
    const inboxDir = join(config.wikiSyncInboxDir, guildId);
    const { files } = await writeMessageInbox(inboxDir, client, messages);
    const prompt = buildSweepTriggerPrompt(files);
    const result = await runWikiSyncSession({ repo, prompt, guildId });

    // Advance past exactly the messages this sweep saw. A crash before this point leaves the
    // watermark untouched, so the same batch is retried rather than silently skipped.
    const latest = messages[messages.length - 1];
    if (latest) setWikiSyncWatermark(db, guildId, latest.createdAt);

    if (result.commitSha) {
      await postSyncStatus({ client, guildId, repo, commitSha: result.commitSha });
    }

    logger.info({ guildId, messageCount: messages.length, commitSha: result.commitSha }, "wiki-sync sweep complete");
    return { ran: true, commitSha: result.commitSha };
  } finally {
    inFlight.delete(guildId);
  }
}
