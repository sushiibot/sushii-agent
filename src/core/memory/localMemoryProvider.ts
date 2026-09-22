import type { MemoryEntry, MemoryProvider, SpaceMemoryStore } from "../contracts.ts";
import { getLogger } from "../../logger.ts";
import { memoryBanks } from "./banks.ts";

const logger = getLogger("core/memory/local");

const DEFAULT_TOKEN_BUDGET = 800;
const DEFAULT_MAX_ITEMS = 6;
const CHARS_PER_TOKEN = 4;
const BLOCK_LABEL = "## Relevant memory";

function deriveTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, 6);
  const title = words.join(" ");
  return title.length > 0 ? title : "memory";
}

function renderItem(entry: MemoryEntry): string {
  // Collapse whitespace in both fields: a title with `\n## ...` could otherwise forge a
  // section in the system prompt this block is injected into.
  const title = entry.title.replace(/\s+/g, " ").trim();
  const content = entry.content.replace(/\s+/g, " ").trim();
  return `- ${title}: ${content}`;
}

// Trim a rendered line to `maxChars`, appending an ellipsis so truncation is visible.
function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  if (maxChars <= 1) return "…";
  return `${line.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Local-store-backed MemoryProvider. Proactive injection against today's FTS DB; the semantic
 * mnemosyne backend swaps in later behind this same interface. The bank string (from `memoryBanks`)
 * is used as the store's space key; `importance` is accepted but not persisted here.
 */
export function createLocalMemoryProvider(store: SpaceMemoryStore): MemoryProvider {
  return {
    async retrieve({ scope, query, deadlineMs, tokenBudget }) {
      // Local FTS is synchronous and fast, but never do work past the caller's deadline.
      if (deadlineMs <= 0) return null;
      const banks = memoryBanks(scope).read;
      if (banks.length === 0) return null;
      const q = query.trim();
      if (q.length === 0) return null;

      const maxItems = DEFAULT_MAX_ITEMS;
      const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;

      // Read each bank (the store treats the bank as its "space" key), then merge in read-bank
      // order — individual bucket first (its hits are the priority), space-general after. Dedupe by
      // `${bank}:${id}` since MemoryEntry.id is a per-store rowid that repeats across bank keys.
      const seen = new Set<string>();
      const hits: MemoryEntry[] = [];
      for (const bank of banks) {
        if (hits.length >= maxItems) break;
        // FTS5 can throw on query metacharacters in raw user text; degrade past that bank.
        let bankHits: MemoryEntry[];
        try {
          bankHits = store.search(bank, q, maxItems);
        } catch (err) {
          logger.debug({ err, bank }, "memory search failed for a bank; skipping it");
          continue;
        }
        for (const entry of bankHits) {
          const key = `${bank}:${entry.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push(entry);
          if (hits.length >= maxItems) break;
        }
      }
      if (hits.length === 0) return null;

      const lines: string[] = [BLOCK_LABEL];
      let usedChars = BLOCK_LABEL.length;
      const budgetChars = Math.max(0, budget) * CHARS_PER_TOKEN;
      let rendered = 0;
      for (const entry of hits) {
        if (rendered >= maxItems) break;
        const line = renderItem(entry);
        const cost = line.length + 1; // +1 for the joining newline
        const remaining = budgetChars - usedChars;
        if (usedChars + cost <= budgetChars) {
          lines.push(line);
          usedChars += cost;
          rendered += 1;
          continue;
        }
        // Over budget: fit a truncated first item so the block is never empty; then stop.
        if (rendered === 0 && remaining > 2) {
          lines.push(truncateLine(line, remaining - 1));
          rendered += 1;
        }
        // Stop on first overflow rather than skipping ahead: hits are relevance-ranked, so
        // dropping the tail preserves the most-relevant items.
        break;
      }

      if (rendered === 0) return null;
      return lines.join("\n");
    },

    async remember({ scope, text }) {
      const bank = memoryBanks(scope).write;
      if (bank === null) return;
      const content = text.trim();
      if (content.length === 0) return;
      const result = store.upsert(bank, deriveTitle(content), content);
      if ("error" in result) {
        logger.debug({ bank, error: result.error }, "memory upsert rejected; not stored");
      }
    },
  };
}
