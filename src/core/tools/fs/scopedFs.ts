import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { getLogger } from "../../../logger.ts";

// Generic filesystem primitives, hard-scoped to a `root` directory (traversal outside is rejected).
// Backs the read_file/search_files/list_files agent tools via an FsHost. ripgrep does the grep scan
// in C; read/list are plain fs. Nothing here is domain-specific — the wiki is just the first root.

const logger = getLogger("core/tools/fs");

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_GREP_LIMIT = 25;

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** Absolute path for `relPath` under `root`, or null if it would escape the root (path traversal). */
export function resolveInRoot(root: string, relPath: string): string | null {
  const base = resolve(root);
  const full = resolve(base, relPath.replace(/^\/+/, ""));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/** ripgrep matches under `root` (case-insensitive), oldest… lines in file order, capped at `limit`.
 *  Missing `rg` or a scan error degrades to no results. */
export async function grepInRoot(root: string, pattern: string, limit = DEFAULT_GREP_LIMIT): Promise<GrepMatch[]> {
  if (!existsSync(root)) return [];
  const matches: GrepMatch[] = [];
  let out: string;
  try {
    const proc = Bun.spawn(["rg", "--json", "-i", "-e", pattern, root], { stdout: "pipe", stderr: "pipe" });
    const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 2) logger.warn({ root }, "ripgrep reported an error");
    out = stdout;
  } catch (err) {
    logger.warn({ err }, "ripgrep unavailable — search returned nothing");
    return matches;
  }

  const rootAbs = resolve(root);
  for (const line of out.split("\n")) {
    if (!line || matches.length >= limit) break;
    let ev: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "match" || !ev.data?.path?.text) continue;
    matches.push({
      path: relative(rootAbs, resolve(ev.data.path.text)).split(sep).join("/"),
      line: ev.data.line_number ?? 0,
      text: (ev.data.lines?.text ?? "").replace(/\s+$/, ""),
    });
  }
  return matches;
}

/** Full content of a file under `root` by relative path, or null if missing / escapes the root. */
export async function readInRoot(root: string, relPath: string): Promise<string | null> {
  const full = resolveInRoot(root, relPath);
  if (!full) return null;
  try {
    const buf = await readFile(full);
    return buf.length > MAX_FILE_BYTES ? buf.toString("utf8").slice(0, MAX_FILE_BYTES) : buf.toString("utf8");
  } catch {
    return null;
  }
}

export interface DirEntry {
  /** Repo-relative path; directories end with "/". */
  path: string;
  isDir: boolean;
}

/** One directory level under `root` (default: the root itself). Null if the dir escapes the root. */
export async function listInRoot(root: string, subDir = ""): Promise<DirEntry[] | null> {
  const full = resolveInRoot(root, subDir);
  if (!full) return null;
  const base = resolve(root);
  let entries;
  try {
    entries = await readdir(full, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((e) => e.name !== ".git")
    .map((e) => {
      const rel = relative(base, resolve(full, e.name)).split(sep).join("/");
      return { path: e.isDirectory() ? `${rel}/` : rel, isDir: e.isDirectory() };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
}
