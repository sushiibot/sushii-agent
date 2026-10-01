import { existsSync } from "node:fs";
import {
  RPC_METHODS,
  SEARCH_RANGES_MAX,
  SEARCH_SNIPPET_MAX,
  historySearchParams,
  historySearchResult,
  searchHit,
  type HistorySearchResult,
  type SearchHit,
} from "../orchestration/contracts.ts";
import { RpcHandlerError } from "../orchestration/transport/client.ts";
import { DAILY_FILE_RE, RUN_FILE_RE, historyRoot, isHistoryRel, openHistoryFile } from "./historyFiles.ts";
import { safeText } from "./runReader.ts";

// history/search: ripgrep finds candidate lines in ~/history; this module then re-opens every hit file
// itself (regular, singly linked, really under the root) and builds the snippet from its own read, so
// nothing rg reports is shown unchecked.

export const SEARCH_WALL_MS = 5_000;
export const SEARCH_STDOUT_MAX = 4 * 1024 * 1024;
export const SEARCH_MATCHES_MAX = 500;
export const SEARCH_CONCURRENCY = 2;
export const SEARCH_DEADLINE_MS = 6_500;
export const SEARCH_READ_BUDGET = 32 * 1024 * 1024;
/** `-M` has no effect under `--json`, so lines are clipped here, around the match, before a snippet is built. */
const LINE_WINDOW = 2_000;
const LEADING_TOKEN = /^[A-Za-z0-9_.+/=~-]+/;
const HIT_FILE_MAX = 1024 * 1024;
const PER_FILE_MAX = 5;
const SNIPPET_LEAD = 60;
const HEADING_MAX = 200;
export const SEARCH_BUSY = "busy";

/** The image's /usr/bin/rg; elsewhere (tests, dev) the one on PATH. Resolved once, never from agent-writable config. */
export function defaultRgPath(): string | null {
  return existsSync("/usr/bin/rg") ? "/usr/bin/rg" : Bun.which("rg");
}

export interface HistorySearchOptions {
  principalId: string;
  home: string;
  rgPath?: string | null;
  /** rg's own wall clock. */
  wallMs?: number;
  /** The whole call, rg plus re-reading hit files; under the bot's 8 s timeout. */
  deadlineMs?: number;
  /** Bytes of hit files re-read per call. */
  readBudget?: number;
}

interface Candidate {
  rel: string;
  line: number;
}

/** Newest day first; on one day the daily file, then run files newest first; line order within a file. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const da = dateOf(a.rel);
  const db = dateOf(b.rel);
  if (da !== db) return da < db ? 1 : -1;
  if (a.rel !== b.rel) {
    const dailyA = DAILY_FILE_RE.test(a.rel);
    if (dailyA !== DAILY_FILE_RE.test(b.rel)) return dailyA ? -1 : 1;
    return a.rel < b.rel ? 1 : -1;
  }
  return a.line - b.line;
}

function dateOf(rel: string): string {
  const run = RUN_FILE_RE.exec(rel);
  return run ? `${run[1]}-${run[2]}` : rel.slice(0, 10);
}

function parseCursor(before: string | undefined): Candidate | null {
  if (before === undefined) return null;
  const at = before.lastIndexOf(":");
  const rel = before.slice(0, at);
  const line = Number(before.slice(at + 1));
  if (at <= 0 || !isHistoryRel(rel) || !Number.isSafeInteger(line) || line < 1) throw new RpcHandlerError("unknown search cursor", -32602);
  return { rel, line };
}

interface RgOutcome {
  candidates: Candidate[];
  truncated: boolean;
}

/** Runs rg with argv only (no shell), in the checked root, and collects match locations under the caps. */
async function runRg(rgPath: string, cwd: string, query: string, daily: boolean, wallMs: number): Promise<RgOutcome> {
  const argv = [
    rgPath,
    "--json",
    "--no-config",
    "--no-ignore",
    "--hidden",
    "--no-messages",
    "-F",
    "-S",
    "--max-filesize",
    "1M",
    "-m",
    String(PER_FILE_MAX),
    "--max-depth",
    daily ? "1" : "2",
    "--sortr",
    "path",
    "-g",
    "*.md",
    "--",
    query,
    ".",
  ];
  const proc = Bun.spawn(argv, { cwd, env: { LC_ALL: "C.UTF-8" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let truncated = false;
  const reader = proc.stdout.getReader();
  // Cancelling the read too: a killed process's children could still hold the pipe open.
  const timer = setTimeout(() => {
    truncated = true;
    proc.kill("SIGKILL");
    reader.cancel().catch(() => {});
  }, wallMs);
  const candidates: Candidate[] = [];
  let bytes = 0;
  let matches = 0;
  let carry = "";
  const decoder = new TextDecoder();
  const take = (line: string) => {
    if (!line.startsWith('{"type":"match"')) return;
    let msg: { data?: { path?: { text?: unknown }; line_number?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    matches++;
    // Non-UTF-8 paths come as `bytes`; history names are ASCII, so those are never ours.
    const path = msg.data?.path?.text;
    const n = msg.data?.line_number;
    if (typeof path !== "string" || typeof n !== "number") return;
    const rel = path.startsWith("./") ? path.slice(2) : path;
    if (isHistoryRel(rel) && Number.isSafeInteger(n) && n > 0) candidates.push({ rel, line: n });
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      const parts = (carry + decoder.decode(value, { stream: true })).split("\n");
      carry = parts.pop() ?? "";
      // A match message carries the whole matched line; one longer than this belongs to no file under the size cap.
      if (carry.length > 4 * 1024 * 1024) carry = "";
      for (const p of parts) {
        take(p);
        if (matches >= SEARCH_MATCHES_MAX) break;
      }
      if (matches >= SEARCH_MATCHES_MAX || bytes >= SEARCH_STDOUT_MAX) {
        truncated = true;
        proc.kill("SIGKILL");
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    proc.kill("SIGKILL");
    await proc.exited;
  }
  return { candidates, truncated };
}

/** UTF-16 offset → code point offset. */
function cpIndex(s: string, unit: number): number {
  let n = 0;
  for (let i = 0; i < unit; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < unit) i++;
    n++;
  }
  return n;
}

/** The snippet around the first match on the redacted line, with match ranges in code points, or null when redaction removed every match. */
export function buildSnippet(rawLine: string, query: string): { snippet: string; ranges: [number, number][] } | null {
  const caseless = !/\p{Lu}/u.test(query);
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseless ? "giu" : "gu");
  // The line is cut to a window around the first raw match before redaction; a cut token at either edge is dropped.
  const first = rawLine.search(re);
  if (first === -1) return null;
  const from = Math.max(0, first - LINE_WINDOW / 2);
  const to = Math.min(rawLine.length, first + LINE_WINDOW / 2);
  let window = rawLine.slice(from, to);
  if (from > 0) window = window.replace(LEADING_TOKEN, "");
  const cutBefore = from > 0;
  const cutAfter = to < rawLine.length;
  const line = safeText(window, LINE_WINDOW, { oneLine: true });
  const units: [number, number][] = [];
  for (const m of line.matchAll(re)) {
    if (m[0].length === 0) break;
    units.push([m.index!, m.index! + m[0].length]);
  }
  if (!units.length) return null;
  const cps = Array.from(line);
  const firstCp = cpIndex(line, units[0]![0]);
  let start = Math.max(0, firstCp - SNIPPET_LEAD);
  let budget = SEARCH_SNIPPET_MAX - 2;
  let end = start;
  while (end < cps.length && budget - cps[end]!.length >= 0) {
    budget -= cps[end]!.length;
    end++;
  }
  // Room left when the line ends early: pull the start back to fill it.
  while (start > 0 && end === cps.length && budget - cps[start - 1]!.length >= 0) {
    budget -= cps[start - 1]!.length;
    start--;
  }
  const leadNow = start > 0 || cutBefore ? "…" : "";
  const tail = end < cps.length || cutAfter ? "…" : "";
  const snippet = leadNow + cps.slice(start, end).join("") + tail;
  const offset = leadNow.length;
  const ranges: [number, number][] = [];
  for (const [a, b] of units) {
    const s = Math.max(cpIndex(line, a), start) - start + offset;
    const e = Math.min(cpIndex(line, b), end) - start + offset;
    if (s < e) ranges.push([s, e]);
    if (ranges.length >= SEARCH_RANGES_MAX) break;
  }
  if (!ranges.length) return null;
  return { snippet, ranges };
}

function hitMeta(rel: string): Pick<SearchHit, "kind" | "date" | "runId"> {
  const daily = DAILY_FILE_RE.exec(rel);
  if (daily) return { kind: "daily", date: daily[1]! };
  const run = RUN_FILE_RE.exec(rel)!;
  return { kind: "run", date: `${run[1]}-${run[2]}`, runId: run[3]! };
}

/** The lines of a hit file from our own checked read, or null when the file is refused. */
async function readLines(root: string, rel: string): Promise<{ lines: string[]; bytes: number } | null> {
  const opened = await openHistoryFile(root, rel);
  if (!opened) return null;
  try {
    const len = Math.min(opened.size, HIT_FILE_MAX);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await opened.fh.read(buf, 0, len, 0);
    return { lines: buf.subarray(0, bytesRead).toString("utf8").split("\n"), bytes: bytesRead };
  } catch {
    return null;
  } finally {
    await opened.fh.close();
  }
}

function headingAbove(lines: string[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.startsWith("## ") || l.startsWith("### ")) return safeText(l.replace(/^#+ /, ""), HEADING_MAX, { oneLine: true }) || undefined;
  }
  return undefined;
}

export class HistorySearch {
  private inFlight = 0;
  private readonly rgPath: string | null;

  constructor(private readonly opts: HistorySearchOptions) {
    this.rgPath = opts.rgPath === undefined ? defaultRgPath() : opts.rgPath;
  }

  async search(p: unknown): Promise<HistorySearchResult> {
    const params = historySearchParams.parse(p);
    if (params.principalId !== this.opts.principalId) throw new Error(`principal mismatch: this workspace serves ${this.opts.principalId}, got ${params.principalId}`);
    const cursor = parseCursor(params.before);
    // NUL can't reach argv, and rg would split a newline into several patterns.
    if (/[\u0000-\u001F\u007F]/.test(params.query)) return { hits: [], before: null, truncated: false };
    if (!this.rgPath) throw new Error("ripgrep is not available");
    if (this.inFlight >= SEARCH_CONCURRENCY) throw new RpcHandlerError(SEARCH_BUSY, -32001);
    this.inFlight++;
    try {
      return await this.run(params.query, params.scope, cursor, params.limit, this.rgPath);
    } finally {
      this.inFlight--;
    }
  }

  private async run(query: string, scope: "all" | "daily" | "runs", cursor: Candidate | null, limit: number, rgPath: string): Promise<HistorySearchResult> {
    const deadline = Date.now() + (this.opts.deadlineMs ?? SEARCH_DEADLINE_MS);
    const root = await historyRoot(this.opts.home);
    if (!root) return { hits: [], before: null, truncated: false };
    const rg = await runRg(rgPath, root, query, scope === "daily", Math.min(this.opts.wallMs ?? SEARCH_WALL_MS, Math.max(0, deadline - Date.now())));
    const wanted = rg.candidates
      .filter((c) => (scope === "daily" ? DAILY_FILE_RE.test(c.rel) : scope === "runs" ? RUN_FILE_RE.test(c.rel) : true))
      .sort(compareCandidates)
      .filter((c) => !cursor || compareCandidates(c, cursor) > 0);
    // Candidates are grouped by file, so only the current file's lines are kept.
    let file = null as { rel: string; lines: string[] | null } | null;
    let readBudget = this.opts.readBudget ?? SEARCH_READ_BUDGET;
    let truncated = rg.truncated;
    const hits: SearchHit[] = [];
    let i = 0;
    for (; i < wanted.length && hits.length < limit; i++) {
      const c = wanted[i]!;
      if (file?.rel !== c.rel) {
        if (Date.now() > deadline || readBudget <= 0) {
          truncated = true;
          break;
        }
        const read = await readLines(root, c.rel);
        readBudget -= read?.bytes ?? 0;
        file = { rel: c.rel, lines: read?.lines ?? null };
      }
      const lines = file.lines;
      const text = lines?.[c.line - 1];
      if (text === undefined) continue;
      const snip = buildSnippet(text, query);
      if (!snip) continue;
      const heading = headingAbove(lines!, c.line - 1);
      const hit: SearchHit = { id: `${c.rel}:${c.line}`, ...hitMeta(c.rel), line: c.line, ...(heading ? { heading } : {}), ...snip };
      if (searchHit.safeParse(hit).success) hits.push(hit);
    }
    const more = i < wanted.length || truncated;
    return historySearchResult.parse({ hits, before: more && hits.length ? hits.at(-1)!.id : null, truncated });
  }
}

export function historySearchHandlers(search: HistorySearch): Record<string, (params: unknown) => Promise<unknown>> {
  return { [RPC_METHODS.historySearch]: (p) => search.search(p) };
}
