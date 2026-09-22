import type { MemoryProvider } from "../../contracts.ts";
import { getLogger } from "../../../logger.ts";
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

/** Namespace each guild's bank so a bare numeric id isn't a weak bank name on a shared server, and
 *  guard blank ids (an empty bank hits the server's default shared bank). One mapping so retrieve
 *  and remember can't drift. Returns null when the space id is empty/blank. */
function toBank(spaceId: string): string | null {
  const s = spaceId.trim();
  if (s.length === 0) return null;
  return `sushii-${s}`;
}

// mnemosyne recall returns `{ status, count, results: [{ content, importance, score, id, ... }] }`
// (confirmed against mnemosyne/mcp_tools.py + hermes_memory_provider consuming `row.get("content")`).
// The MCP SDK does NOT throw on a server-side error envelope, so we inspect the parsed payload:
// `malformed` distinguishes an erroring/misconfigured server (warn) from a genuine empty result set.
function parseRecallHits(payload: unknown): { hits: RenderableMemory[]; malformed: boolean } {
  const obj = payload as { status?: unknown; results?: unknown } | null;
  const results = obj?.results;
  if (obj?.status !== "ok" || !Array.isArray(results)) {
    return { hits: [], malformed: true };
  }
  const hits: RenderableMemory[] = [];
  for (const row of results) {
    const content = typeof (row as { content?: unknown })?.content === "string"
      ? (row as { content: string }).content
      : "";
    if (content.trim().length === 0) continue;
    hits.push({ content });
  }
  return { hits, malformed: false };
}

/** epoch-ms → mnemosyne's ISO date (`YYYY-MM-DD`) valid_until. Out-of-range values (which would
 *  make `Date` throw on ISO conversion) yield undefined rather than throwing. */
function toValidUntil(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

/**
 * mnemosyne-backed MemoryProvider (semantic recall over MCP). `bank = sushii-<spaceId>` isolates
 * each guild. Best-effort by contract: any recall failure or deadline overrun yields `null` (never
 * blocks a turn) and any remember failure is logged and swallowed.
 */
export function createMnemosyneMemoryProvider(opts: MnemosyneProviderOptions): MemoryProvider {
  const { callTool } = opts;
  const recallLimit = opts.recallLimit ?? DEFAULT_RECALL_LIMIT;
  const logger = opts.logger ?? defaultLogger;

  return {
    async retrieve({ spaceId, query, deadlineMs, tokenBudget }) {
      if (deadlineMs <= 0) return null;
      const bank = toBank(spaceId);
      if (bank === null) return null;
      const q = query.trim();
      if (q.length === 0) return null;

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Race the network call against the deadline: resolve to null rather than hang even if the
      // seam ignores the abort signal (agentCore also races, but retrieve is defensive on its own).
      const deadline = new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(DEADLINE);
        }, deadlineMs);
      });

      try {
        const raw = await Promise.race([
          callTool(RECALL_TOOL, { bank, query: q, limit: recallLimit }, controller.signal),
          deadline,
        ]);
        if (raw === DEADLINE) {
          logger.debug({ spaceId, deadlineMs }, "mnemosyne recall hit deadline; skipping injection");
          return null;
        }
        const { hits, malformed } = parseRecallHits(raw);
        if (malformed) {
          logger.warn({ spaceId }, "mnemosyne recall returned an unexpected shape; skipping injection");
          return null;
        }
        if (hits.length === 0) return null;
        return renderMemoryBlock(hits, { maxItems: recallLimit, tokenBudget });
      } catch (err) {
        logger.debug({ err, spaceId }, "mnemosyne recall failed; skipping injection");
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    async remember({ spaceId, text, importance, scope, validUntil }) {
      const bank = toBank(spaceId);
      if (bank === null) return;
      const content = text.trim();
      if (content.length === 0) return;

      try {
        const args: Record<string, unknown> = { bank, content };
        if (importance !== undefined) args["importance"] = importance;
        // Default to a durable cross-session scope; the server otherwise defaults to session-scoped.
        args["scope"] = scope ?? "global";
        if (validUntil !== undefined) {
          const iso = toValidUntil(validUntil);
          if (iso !== undefined) args["valid_until"] = iso;
        }

        const raw = await callTool(REMEMBER_TOOL, args);
        // The MCP SDK does NOT throw on a filtered/errored write — inspect the parsed payload so a
        // silently-dropped fact is diagnosable.
        const status = (raw as { status?: unknown } | null)?.status;
        if (status !== "stored") {
          logger.warn({ spaceId, status }, "mnemosyne remember did not store the fact");
        }
      } catch (err) {
        logger.warn({ err, spaceId }, "mnemosyne remember failed; fact not persisted");
      }
    },
  };
}
