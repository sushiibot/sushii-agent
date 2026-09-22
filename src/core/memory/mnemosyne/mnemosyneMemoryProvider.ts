import type { MemoryProvider } from "../../contracts.ts";
import { getLogger } from "../../../logger.ts";
import { memoryBanks } from "../banks.ts";
import { renderMemoryBlock, type RenderableMemory } from "./renderMemoryBlock.ts";

const defaultLogger = getLogger("core/memory/mnemosyne");

const RECALL_TOOL = "mnemosyne_recall";
const REMEMBER_TOOL = "mnemosyne_remember";
const DEFAULT_RECALL_LIMIT = 6;

/** Injectable call seam. Returns mnemosyne's already-parsed tool payload (the JSON envelope the
 *  tool emits as a text content block), NOT the raw MCP content array — the default seam handles
 *  extraction so tests can hand back a plain object. `signal` lets a real transport abort. */
export type McpToolCall = (
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface MnemosyneProviderOptions {
  callTool: McpToolCall;
  /** `limit`/top-k passed to mnemosyne_recall (also caps rendered items). */
  recallLimit?: number;
  logger?: { debug: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

const DEADLINE = Symbol("mnemosyne-recall-deadline");

/** A parsed recall hit, carrying the fields needed to merge across banks (dedupe by `id`, rank by
 *  `score`) before rendering. */
interface RecallHit {
  id: string | null;
  content: string;
  score: number | null;
}

// mnemosyne recall returns `{ status, count, results: [{ content, importance, score, id, ... }] }`
// (confirmed against mnemosyne/mcp_tools.py + hermes_memory_provider consuming `row.get("content")`).
// The MCP SDK does NOT throw on a server-side error envelope, so we inspect the parsed payload:
// `malformed` distinguishes an erroring/misconfigured server OR a not-yet-created bank (both warn,
// per-bank) from a genuine empty result set. A cold bank must not zero out the whole read set.
function parseRecallHits(payload: unknown): { hits: RecallHit[]; malformed: boolean } {
  const obj = payload as { status?: unknown; results?: unknown } | null;
  const results = obj?.results;
  if (obj?.status !== "ok" || !Array.isArray(results)) {
    return { hits: [], malformed: true };
  }
  const hits: RecallHit[] = [];
  for (const row of results) {
    const r = row as { content?: unknown; id?: unknown; score?: unknown };
    const content = typeof r?.content === "string" ? r.content : "";
    if (content.trim().length === 0) continue;
    const id = typeof r?.id === "string" ? r.id : null;
    const score = typeof r?.score === "number" ? r.score : null;
    hits.push({ id, content, score });
  }
  return { hits, malformed: false };
}

/** Merge hits across banks: dedupe by `${bank}:${id}` (id-less hits are all kept), cap at `limit`.
 *  mnemosyne ids look per-bank (sequence-like), so the bank must be part of the key — a bare id would
 *  drop a genuinely distinct fact that happens to share an id. First occurrence of a key wins.
 *  Ranking: sort by `score` desc ONLY when every hit carries a real score; if any score is missing,
 *  preserve bank insertion order (individual bank first per `memoryBanks().read`) so a scoreless
 *  individual fact is never evicted by a scored space-general one — the brief's individual-first rule. */
function mergeHits(banks: { bank: string; hits: RecallHit[] }[], limit: number): RenderableMemory[] {
  const seen = new Set<string>();
  const merged: RecallHit[] = [];
  for (const { bank, hits } of banks) {
    for (const hit of hits) {
      if (hit.id !== null) {
        const key = `${bank}:${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(hit);
    }
  }
  if (merged.every((h) => h.score !== null)) {
    merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  return merged.slice(0, limit).map((h) => ({ content: h.content }));
}

/**
 * mnemosyne-backed MemoryProvider (semantic recall over MCP). Banks are keyed by `memoryBanks`
 * (per-user / per-space / DM buckets). Best-effort by contract: any recall failure or deadline
 * overrun yields `null` (never blocks a turn) and any remember failure is logged and swallowed.
 */
export function createMnemosyneMemoryProvider(opts: MnemosyneProviderOptions): MemoryProvider {
  const { callTool } = opts;
  const recallLimit = opts.recallLimit ?? DEFAULT_RECALL_LIMIT;
  const logger = opts.logger ?? defaultLogger;

  return {
    async retrieve({ scope, query, deadlineMs, tokenBudget }) {
      if (deadlineMs <= 0) return null;
      const banks = memoryBanks(scope).read;
      if (banks.length === 0) return null;
      const q = query.trim();
      if (q.length === 0) return null;

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Race ALL bank calls against the SINGLE deadline (total, not per-bank): resolve to null
      // rather than hang even if the seam ignores the abort signal.
      const deadline = new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(DEADLINE);
        }, deadlineMs);
      });

      try {
        const settled = await Promise.race([
          Promise.allSettled(
            banks.map((bank) => callTool(RECALL_TOOL, { bank, query: q, limit: recallLimit }, controller.signal)),
          ),
          deadline,
        ]);
        if (settled === DEADLINE) {
          logger.debug({ banks, deadlineMs }, "mnemosyne recall hit deadline; skipping injection");
          return null;
        }

        const perBank: { bank: string; hits: RecallHit[] }[] = [];
        let malformed = false;
        settled.forEach((outcome, i) => {
          const bank = banks[i]!;
          if (outcome.status === "rejected") {
            // A rejected bank contributes nothing; the merged set from the others still stands.
            logger.debug({ err: outcome.reason, bank }, "mnemosyne recall failed for a bank; skipping it");
            return;
          }
          const parsed = parseRecallHits(outcome.value);
          if (parsed.malformed) {
            malformed = true; // cold or misconfigured bank — warn once below, don't zero the set
            return;
          }
          perBank.push({ bank, hits: parsed.hits });
        });
        // Warn at most once per retrieve, and only when NO bank yielded a usable shape (an erroring
        // server), not when a cold bank simply doesn't exist yet alongside a good one.
        if (malformed && perBank.length === 0) {
          logger.warn({ banks }, "mnemosyne recall returned an unexpected shape; skipping injection");
          return null;
        }

        const hits = mergeHits(perBank, recallLimit);
        if (hits.length === 0) return null;
        return renderMemoryBlock(hits, { maxItems: recallLimit, tokenBudget });
      } catch (err) {
        logger.debug({ err, banks }, "mnemosyne recall failed; skipping injection");
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    async remember({ scope, text, importance }) {
      const bank = memoryBanks(scope).write;
      if (bank === null) return;
      const content = text.trim();
      if (content.length === 0) return;

      try {
        const args: Record<string, unknown> = { bank, content };
        if (importance !== undefined) args["importance"] = importance;
        // mnemosyne durability scope stays "global" (durable cross-session); the server otherwise
        // defaults to session-scoped. This is unrelated to the read/write bank scoping above.
        args["scope"] = "global";

        const raw = await callTool(REMEMBER_TOOL, args);
        // The MCP SDK does NOT throw on a filtered/errored write — inspect the parsed payload so a
        // silently-dropped fact is diagnosable.
        const status = (raw as { status?: unknown } | null)?.status;
        if (status !== "stored") {
          logger.warn({ bank, status }, "mnemosyne remember did not store the fact");
        }
      } catch (err) {
        logger.warn({ err, bank }, "mnemosyne remember failed; fact not persisted");
      }
    },
  };
}
