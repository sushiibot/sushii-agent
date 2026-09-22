// Renders the `## Relevant memory` block for mnemosyne recall hits. Hits arrive as bare content
// with no stored title, so each line renders content-only (`- <content>`) rather than duplicating
// the content as its own derived title.

const DEFAULT_TOKEN_BUDGET = 800;
const DEFAULT_MAX_ITEMS = 6;
const CHARS_PER_TOKEN = 4;
const BLOCK_LABEL = "## Relevant memory";

export interface RenderableMemory {
  content: string;
}

function renderItem(entry: RenderableMemory): string {
  // Collapse whitespace: content with `\n## ...` could otherwise forge a section in the system
  // prompt this block is injected into.
  const content = entry.content.replace(/\s+/g, " ").trim();
  return `- ${content}`;
}

function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  if (maxChars <= 1) return "…";
  return `${line.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Token-bounded, item-capped block. Empty input (or everything trimmed to nothing) → null. */
export function renderMemoryBlock(
  hits: RenderableMemory[],
  opts?: { maxItems?: number; tokenBudget?: number },
): string | null {
  const maxItems = opts?.maxItems ?? DEFAULT_MAX_ITEMS;
  const budget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
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
    // Stop on first overflow: hits are relevance-ranked, so dropping the tail keeps the best.
    break;
  }

  if (rendered === 0) return null;
  return lines.join("\n");
}
