import { SpanStatusCode } from "@opentelemetry/api";
import { join } from "node:path";
import { config } from "../../config.ts";
import { getDb } from "../../db/index.ts";
import { getLogger } from "../../logger.ts";
import { tracer } from "../../telemetry.ts";
import { getWikiSyncWatermark, setWikiSyncWatermark } from "../../db/wikiSync.ts";
import { COMMITTER_NAME, openWikiRepo, type WikiRepo } from "./git.ts";
import { writeMessageInbox, type InboxFile } from "./inbox.ts";
import type { WikiSyncContext } from "./context.ts";
import { getWikiSources, type WikiSource } from "./sources.ts";
import { runWikiSyncSession } from "./piSession.ts";
import { buildSweepTriggerPrompt } from "./prompt.ts";

const logger = getLogger("wiki-sync:sweep");

/** Guards against the cron tick and an on-demand /wiki-sync command racing on the same wiki's
 *  working tree. Keyed on `wikiId`: one wiki is swept source-by-source under a single lock, which
 *  is what serializes commits and prevents a git clobber across a shared wiki's sources. */
const inFlight = new Set<string>();

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Primary sweep-size boundary: a few calendar days of backlog, not an arbitrary message count.
// A count-only cap either truncates a normal day's chatter for no reason, or (backlog catch-up,
// a raid, an unusually busy day) lets a single sweep's input balloon to whatever volume happened
// to land in an unbounded window -- the exact axis that risked a stuck/overlong sweep before.
// 3 days gives headroom over the daily cron's actual cadence so this boundary basically never
// triggers in steady state; maxMessagesPerSweep is the real backstop for an abnormally busy span.
const MAX_SWEEP_SPAN_MS = 3 * 24 * 60 * 60 * 1000;

export interface SourceSweepResult {
  surface: string;
  spaceId: string;
  ran: boolean;
  reason?: string;
  commitSha?: string | null;
}

export interface SweepResult {
  ran: boolean;
  reason?: string;
  /** Per-source outcome, in sweep order. Empty when the whole sweep was skipped (lock held). */
  sources: SourceSweepResult[];
}

/** True if a sweep for this wiki is already running — lets a caller (e.g. the /wiki-sync command) decide upfront without waiting on runWikiSyncSweep itself. */
export function isSweepInFlight(wikiId: string): boolean {
  return inFlight.has(wikiId);
}

/** Yields the port bag for one source of a wiki, or null when this surface has no context yet
 *  (e.g. a non-Discord source before its surface is wired). */
export type MakeSourceContext = (source: WikiSource) => WikiSyncContext | null;

/** Sweeps one source, serialized under the caller's per-wiki lock. Keeps today's exact single-source
 *  watermark/window logic — only re-keyed to `(wikiId, surface, spaceId)` and put behind ports. */
async function sweepSource(
  wikiId: string,
  source: WikiSource,
  ctx: WikiSyncContext,
  repo: WikiRepo,
  runId: string,
): Promise<SourceSweepResult> {
  const db = getDb();
  const log = logger.child({ wikiId, surface: source.surface, spaceId: source.spaceId, runId });

  // Floor against the message-retention window so a stale/missing watermark (first run,
  // long-dead bot) can't try to scan further back than the DB actually has.
  const floor = Date.now() - RETENTION_MS;
  const watermark = Math.max(getWikiSyncWatermark(db, wikiId, source.surface, source.spaceId), floor);
  // Never past "now" -- a fresh/caught-up watermark shouldn't produce a window into the
  // future. During backlog catch-up this instead lands one day past the watermark, well
  // short of "now", so subsequent sweeps keep walking forward day by day.
  const until = Math.min(watermark + MAX_SWEEP_SPAN_MS, Date.now());

  return tracer.startActiveSpan(
    `wiki_sync.source ${source.surface}`,
    { attributes: { "wiki_sync.surface": source.surface, "wiki_sync.space_id": source.spaceId } },
    async (span) => {
      try {
        const messages = await ctx.messages.fetchUnprocessed(source.spaceId, watermark, until, config.wikiSync.maxMessagesPerSweep);
        span.setAttribute("wiki_sync.message_count", messages.length);
        if (messages.length === 0) {
          // Advance to the window's end, not Date.now() -- jumping straight to "now" would skip
          // over any days between `until` and now that do have messages still waiting.
          setWikiSyncWatermark(db, wikiId, source.surface, source.spaceId, until);
          span.setAttribute("wiki_sync.reason", "no new messages");
          return { surface: source.surface, spaceId: source.spaceId, ran: true, reason: "no new messages" };
        }

        // Sibling of the repo checkout, outside its git working tree entirely — see inbox.ts.
        // Deepened per source so concurrent-per-wiki sources can't clobber each other's inbox;
        // it is wiped and rebuilt every sweep, so this path change carries no on-disk migration.
        const inboxDir = join(config.wikiSync.inboxDir, wikiId, source.surface, source.spaceId);
        const { files: allFiles } = await writeMessageInbox(inboxDir, ctx, messages);

        // The status channel (and any thread on a message wiki-sync posted there, e.g. the
        // per-sweep "discuss this sync" thread from notify.ts) isn't community content to build
        // wiki pages from -- it's where people talk about wiki-sync's own output. Routed to
        // buildSweepTriggerPrompt's separate feedback section instead of the regular content list.
        const statusChannelId = source.statusChannelId;
        const isFeedback = (f: InboxFile) =>
          f.surface === source.surface && (f.channelId === statusChannelId || f.parentChannelId === statusChannelId);
        const files = statusChannelId ? allFiles.filter((f) => !isFeedback(f)).map((f) => f.path) : allFiles.map((f) => f.path);
        const feedbackFiles = statusChannelId ? allFiles.filter(isFeedback).map((f) => f.path) : [];

        const prompt = buildSweepTriggerPrompt(files, feedbackFiles);
        const result = await runWikiSyncSession({ repo, prompt, inboxDir, wikiId, runId });
        span.setAttribute("wiki_sync.commit_sha", result.commitSha ?? "");

        // Advance past exactly the messages this sweep saw. A crash before this point leaves the
        // watermark untouched, so the same batch is retried rather than silently skipped.
        const latest = messages[messages.length - 1];
        if (latest) setWikiSyncWatermark(db, wikiId, source.surface, source.spaceId, latest.createdAt);

        if (result.commitSha) {
          await ctx.notify.postStatus({ repo, commitSha: result.commitSha });
        }

        log.info({ messageCount: messages.length, commitSha: result.commitSha }, "source sweep complete");
        return { surface: source.surface, spaceId: source.spaceId, ran: true, commitSha: result.commitSha };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : errMsg);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Sweeps one wiki: under a per-`wikiId` lock, opens its repo once, then sweeps each of its sources
 * serially (own inbox, own Pi session, own commit, own watermark). `makeContext(source)` yields the
 * port bag for a source, or null to skip a surface that has no context yet.
 *
 * `runId` correlates this call across the immediate command reply, logs, and the eventual
 * status-channel post — generated by the caller (e.g. a short id shown to the user right away)
 * when the caller isn't going to wait for this promise to resolve. Defaults to a fresh one for
 * callers that don't care (the scheduler).
 */
export async function runWikiSyncSweep(
  wikiId: string,
  makeContext: MakeSourceContext,
  runId: string = crypto.randomUUID().slice(0, 8),
): Promise<SweepResult> {
  if (inFlight.has(wikiId)) {
    return { ran: false, reason: "a sweep is already running for this wiki", sources: [] };
  }
  inFlight.add(wikiId);

  // Span name/attributes follow the OTel GenAI semantic conventions' "invoke_agent" span
  // (gen-ai-agent-spans.md): one whole agent run, of which each source's model turns are nested
  // spans. wiki_sync.* attributes stay custom -- no standard slot for wiki/run identity.
  return tracer.startActiveSpan(
    `invoke_agent ${COMMITTER_NAME}`,
    {
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": COMMITTER_NAME,
        "wiki_sync.wiki_id": wikiId,
        "wiki_sync.run_id": runId,
      },
    },
    async (span) => {
      const log = logger.child({ wikiId, runId });
      try {
        const sources = getWikiSources().get(wikiId) ?? [];
        const repo = await openWikiRepo(wikiId);
        const results: SourceSweepResult[] = [];

        // Serialized, per-source try/catch: one source failing must not abort the others, and each
        // keeps its own watermark, so a retry re-runs only the source that failed.
        for (const source of sources) {
          const ctx = makeContext(source);
          if (!ctx) {
            log.warn({ surface: source.surface, spaceId: source.spaceId }, "no context for source surface, skipping");
            continue;
          }
          try {
            results.push(await sweepSource(wikiId, source, ctx, repo, runId));
          } catch (err) {
            log.error({ surface: source.surface, spaceId: source.spaceId, err }, "source sweep failed");
            results.push({ surface: source.surface, spaceId: source.spaceId, ran: false, reason: "source sweep failed" });
          }
        }

        return { ran: true, sources: results };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : errMsg);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
        throw err;
      } finally {
        span.end();
        inFlight.delete(wikiId);
      }
    },
  );
}
