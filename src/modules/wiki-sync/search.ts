import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getLogger } from "../../logger.ts";

// Targeted search over a wiki repo's markdown pages (the local clone wiki-sync keeps updated).
// ripgrep does the O(wiki) scan in C and returns only matching files; we then read just the top few
// hits to format a title + snippet. Reflects the last sweep — no per-search network pull.

const logger = getLogger("wiki-sync:search");

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

interface FileMatch {
  count: number;
  terms: Set<string>;
}

/** Runs ripgrep over the repo's markdown, returning per-file total-hit count + distinct terms hit.
 *  ripgrep skips the hidden .git dir by default. Missing `rg` / a scan error degrades to no results. */
async function ripgrepMatches(dir: string, pattern: string): Promise<Map<string, FileMatch>> {
  const map = new Map<string, FileMatch>();
  let out: string;
  try {
    const proc = Bun.spawn(["rg", "--json", "-i", "--glob", "*.md", "-e", pattern, dir], { stdout: "pipe", stderr: "pipe" });
    const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 2) logger.warn({ dir }, "ripgrep reported an error scanning the wiki");
    out = stdout;
  } catch (err) {
    logger.warn({ err }, "ripgrep unavailable — wiki search returned nothing");
    return map;
  }

  for (const line of out.split("\n")) {
    if (!line) continue;
    let ev: { type?: string; data?: { path?: { text?: string }; submatches?: { match?: { text?: string } }[] } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "match" || !ev.data?.path?.text) continue;
    const relPath = relative(dir, ev.data.path.text).split(sep).join("/");
    const entry = map.get(relPath) ?? { count: 0, terms: new Set<string>() };
    for (const sm of ev.data.submatches ?? []) {
      if (sm.match?.text) {
        entry.count++;
        entry.terms.add(sm.match.text.toLowerCase());
      }
    }
    map.set(relPath, entry);
  }
  return map;
}

export async function searchWikiPages(dir: string, query: string, limit = 5): Promise<WikiHit[]> {
  if (!existsSync(dir)) return [];
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const matches = await ripgrepMatches(dir, terms.join("|"));
  const ranked = [...matches.entries()]
    // Multi-term queries require every term to appear in the page (AND); single-term passes on any hit.
    .filter(([, m]) => terms.length === 1 || m.terms.size === terms.length)
    // A page that hits more distinct terms wins; ties break on total hit count (mentioned more = more relevant).
    .sort(([, a], [, b]) => b.terms.size - a.terms.size || b.count - a.count)
    .slice(0, limit);

  const hits: WikiHit[] = [];
  for (const [relPath, m] of ranked) {
    try {
      const buf = await readFile(join(dir, relPath));
      const content = buf.length > MAX_FILE_BYTES ? buf.toString("utf8").slice(0, MAX_FILE_BYTES) : buf.toString("utf8");
      hits.push({ path: relPath, title: titleOf(relPath, content), snippet: snippetFor(content, terms), score: m.terms.size * 1000 + m.count });
    } catch {
      // A file that matched but can't be read (race with a sweep reset) — skip it.
    }
  }
  return hits;
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
