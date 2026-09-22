import type { MemoryProvider } from "../../contracts.ts";
import { getLogger } from "../../../logger.ts";
import { deriveTitle, renderMemoryBlock, type RenderableMemory } from "./renderMemoryBlock.ts";

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

// mnemosyne recall returns `{ status, count, results: [{ content, importance, score, id, ... }] }`
// (confirmed against mnemosyne/mcp_tools.py + hermes_memory_provider consuming `row.get("content")`).
function parseRecallHits(payload: unknown): RenderableMemory[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const hits: RenderableMemory[] = [];
  for (const row of results) {
    const content = typeof (row as { content?: unknown })?.content === "string"
      ? (row as { content: string }).content
      : "";
    if (content.trim().length === 0) continue;
    hits.push({ title: deriveTitle(content), content });
  }
  return hits;
}

/** epoch-ms → mnemosyne's ISO date (`YYYY-MM-DD`) valid_until. */
function toValidUntil(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * mnemosyne-backed MemoryProvider (semantic recall over MCP). `bank = spaceId` isolates each guild.
 * Best-effort by contract: any recall failure or deadline overrun yields `null` (never blocks a
 * turn) and any remember failure is logged and swallowed.
 */
export function createMnemosyneMemoryProvider(opts: MnemosyneProviderOptions): MemoryProvider {
  const { callTool } = opts;
  const recallLimit = opts.recallLimit ?? DEFAULT_RECALL_LIMIT;
  const logger = opts.logger ?? defaultLogger;

  return {
    async retrieve({ spaceId, query, deadlineMs, tokenBudget }) {
      if (deadlineMs <= 0) return null;
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
          callTool(RECALL_TOOL, { bank: spaceId, query: q, limit: recallLimit }, controller.signal),
          deadline,
        ]);
        if (raw === DEADLINE) {
          logger.debug({ spaceId, deadlineMs }, "mnemosyne recall hit deadline; skipping injection");
          return null;
        }
        const hits = parseRecallHits(raw);
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
      const content = text.trim();
      if (content.length === 0) return;

      const args: Record<string, unknown> = { bank: spaceId, content };
      if (importance !== undefined) args["importance"] = importance;
      if (scope !== undefined) args["scope"] = scope;
      if (validUntil !== undefined) {
        const iso = toValidUntil(validUntil);
        if (iso !== undefined) args["valid_until"] = iso;
      }

      try {
        await callTool(REMEMBER_TOOL, args);
      } catch (err) {
        logger.warn({ err, spaceId }, "mnemosyne remember failed; fact not persisted");
      }
    },
  };
}
