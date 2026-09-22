// Duplicated from localMemoryProvider's renderer so both backends inject an identical
// `## Relevant memory` block shape regardless of which store answered. Kept as a tiny
// standalone helper (localMemoryProvider stays untouched) rather than a shared import.

const DEFAULT_TOKEN_BUDGET = 800;
const DEFAULT_MAX_ITEMS = 6;
const CHARS_PER_TOKEN = 4;
const BLOCK_LABEL = "## Relevant memory";

export interface RenderableMemory {
  title: string;
  content: string;
}

/** First 6 words of the first line — mirrors localMemoryProvider.deriveTitle for recall hits,
 *  which come back as bare content with no stored title. */
export function deriveTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, 6);
  const title = words.join(" ");
  return title.length > 0 ? title : "memory";
}

function renderItem(entry: RenderableMemory): string {
  // Collapse whitespace in both fields: a title with `\n## ...` could otherwise forge a
  // section in the system prompt this block is injected into.
  const title = entry.title.replace(/\s+/g, " ").trim();
  const content = entry.content.replace(/\s+/g, " ").trim();
  return `- ${title}: ${content}`;
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
