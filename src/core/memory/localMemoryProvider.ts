import type { MemoryEntry, MemoryProvider, SpaceMemoryStore } from "../contracts.ts";

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
  const content = entry.content.replace(/\s+/g, " ").trim();
  return `- ${entry.title}: ${content}`;
}

// Trim a rendered line to `maxChars`, appending an ellipsis so truncation is visible.
function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  if (maxChars <= 1) return "…";
  return `${line.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Local-store-backed MemoryProvider. Proactive injection against today's FTS DB; the semantic
 * mnemosyne backend swaps in later behind this same interface. `importance`/`scope`/`validUntil`
 * are accepted but not persisted here — the future mnemosyne impl honors them.
 */
export function createLocalMemoryProvider(store: SpaceMemoryStore): MemoryProvider {
  return {
    async retrieve({ spaceId, query, deadlineMs, tokenBudget }) {
      // Local FTS is synchronous and fast, but never do work past the caller's deadline.
      if (deadlineMs <= 0) return null;
      const q = query.trim();
      if (q.length === 0) return null;

      const maxItems = DEFAULT_MAX_ITEMS;
      const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;

      const hits = store.search(spaceId, q, maxItems);
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
        break;
      }

      if (rendered === 0) return null;
      return lines.join("\n");
    },

    async remember({ spaceId, text }) {
      const content = text.trim();
      if (content.length === 0) return;
      store.upsert(spaceId, deriveTitle(content), content);
    },
  };
}
