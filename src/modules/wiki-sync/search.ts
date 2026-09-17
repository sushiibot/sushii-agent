import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// Dependency-free search over a wiki repo's markdown pages (the local clone wiki-sync keeps updated).
// No ripgrep/FTS: a wiki is a few dozen–hundred pages, and the agent searches only occasionally, so
// reading + scoring on demand is simple and needs nothing installed in the container.

export interface WikiHit {
  /** Repo-relative path, e.g. "people/alice.md". */
  path: string;
  title: string;
  snippet: string;
  score: number;
}

const SNIPPET_RADIUS = 160;
const MAX_FILE_BYTES = 512 * 1024;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** First `# ` heading, else the filename without extension. */
function titleOf(path: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const base = path.split(sep).pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/** A snippet centered on the first occurrence of any query term, collapsed to one line. */
function snippetFor(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return content.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(content.length, at + SNIPPET_RADIUS);
  const body = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < content.length ? "…" : ""}`;
}

async function markdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

export async function searchWikiPages(dir: string, query: string, limit = 5): Promise<WikiHit[]> {
  if (!existsSync(dir)) return [];
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const files = await markdownFiles(dir);
  const hits: WikiHit[] = [];

  for (const file of files) {
    let content: string;
    try {
      const buf = await readFile(file);
      if (buf.length > MAX_FILE_BYTES) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    const relPath = relative(dir, file).split(sep).join("/");
    const title = titleOf(relPath, content);
    const haystack = `${relPath}\n${title}\n${content}`.toLowerCase();
    const titlePathHay = `${relPath}\n${title}`.toLowerCase();

    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const inBody = haystack.split(term).length - 1;
      if (inBody > 0) matched++;
      // Title/path matches weigh more — a page named for the term is likely the best answer.
      const inTitlePath = titlePathHay.split(term).length - 1;
      score += inBody + inTitlePath * 4;
    }
    if (score === 0) continue;
    // Require every multi-term query term to appear somewhere, so "alice ban history" doesn't match
    // a page that only mentions "history"; single-term queries pass on any hit.
    if (terms.length > 1 && matched < terms.length) continue;

    hits.push({ path: relPath, title, snippet: snippetFor(content, terms), score });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Full content of a repo-relative wiki page, or null if missing / path escapes the repo. */
export async function readWikiPage(dir: string, relPath: string): Promise<string | null> {
  const normalized = relPath.replace(/^\/+/, "");
  const full = join(dir, normalized);
  // Reject path traversal outside the repo.
  if (!full.startsWith(dir + sep) && full !== dir) return null;
  if (!full.toLowerCase().endsWith(".md")) return null;
  try {
    const buf = await readFile(full);
    if (buf.length > MAX_FILE_BYTES) return buf.toString("utf8").slice(0, MAX_FILE_BYTES);
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
