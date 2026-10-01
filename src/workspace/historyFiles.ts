import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import {
  HISTORY_DAY_RUNS_MAX,
  HISTORY_DAY_SESSIONS_MAX,
  HISTORY_RECAP_MAX,
  RPC_METHODS,
  RUN_KINDS,
  RUN_STATUSES,
  historyDayParams,
  historyDayResult,
  historyDaysParams,
  historyDaysResult,
  isCalendarDate,
  runSummary,
  type HistoryDayResult,
  type HistoryDaysResult,
  type RunKind,
  type RunStatus,
  type RunSummary,
} from "../orchestration/contracts.ts";
import { HISTORY_DIR } from "./history.ts";
import { runLogPath } from "./runLog.ts";
import { SAFE_OPEN, fdPath, runIdTime, safeText, scanRunIndex, toRunSummary } from "./runReader.ts";

// Read side of ~/history for the History screens. The dir is agent-writable, so the root is re-checked on
// every call, names are built from validated dates and run ids, and a file is read only when it is a
// regular, singly linked file that really sits where its name says.

export const HISTORY_FILE_MAX = 1024 * 1024;
export const DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
export const RUN_FILE_RE = /^(\d{4}-\d{2})\/(\d{2})-([0-9A-HJKMNP-TV-Z]{26})\.md$/;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const RUN_NAME_RE = /^(\d{2})-([0-9A-HJKMNP-TV-Z]{26})\.md$/;
/** Entries read from one directory listing; the agent can create any number. */
const DIR_ENTRIES_MAX = 10_000;
/** Directory entries read per `history/days` call, across the root and every month dir. */
const DAYS_SCAN_MAX = 40_000;
const RUN_HEADER_MAX = 16 * 1024;
/** A whole history/day result, serialized, stays under this: the bot rejects anything over 2 MB. */
const DAY_BUDGET = 1_400_000;

/** The real path of `<home>/history` when it is a plain directory (not a symlink), else null. */
export async function historyRoot(home: string): Promise<string | null> {
  const dir = join(home, HISTORY_DIR);
  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    return await realpath(dir);
  } catch {
    return null;
  }
}

async function plainDir(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `rel` is a history file name the host writes. */
export function isHistoryRel(rel: string): boolean {
  if (DAILY_FILE_RE.test(rel)) return isCalendarDate(rel.slice(0, 10));
  const m = RUN_FILE_RE.exec(rel);
  return !!m && isCalendarDate(`${m[1]}-${m[2]}`);
}

export interface HistoryRead {
  text: string;
  /** The file was larger than the cap; `text` is its head. */
  truncated: boolean;
}

/**
 * Opens `<root>/<rel>` when `rel` is a history file name and the file is regular, singly linked and really at
 * that path (a symlinked month dir or a hardlink from elsewhere on the volume is refused). `root` is a real path.
 */
export async function openHistoryFile(root: string, rel: string): Promise<{ fh: FileHandle; size: number } | null> {
  if (!isHistoryRel(rel)) return null;
  const path = join(root, rel);
  if (rel.includes("/") && !(await plainDir(join(root, rel.slice(0, rel.indexOf("/")))))) return null;
  let fh: FileHandle;
  try {
    fh = await open(path, SAFE_OPEN);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1) throw new Error("refused");
    const at = fdPath(fh.fd) ?? (await realpath(path));
    if (at !== path) throw new Error("refused");
    return { fh, size: st.size };
  } catch {
    await fh.close();
    return null;
  }
}

export async function readHistoryFile(root: string, rel: string, max = HISTORY_FILE_MAX): Promise<HistoryRead | null> {
  const opened = await openHistoryFile(root, rel);
  if (!opened) return null;
  try {
    const len = Math.min(opened.size, max);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await opened.fh.read(buf, 0, len, 0);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: opened.size > max };
  } catch {
    return null;
  } finally {
    await opened.fh.close();
  }
}

/** A regular file with one link: a hardlink from elsewhere on the volume doesn't count as a history file. */
async function singleFile(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isFile() && st.nlink === 1;
  } catch {
    return false;
  }
}

/** The entries of `dir` for which `keep` holds, checked a batch at a time. */
async function filterFiles<T>(dir: string, items: T[], name: (t: T) => string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += 256) {
    const batch = items.slice(i, i + 256);
    const ok = await Promise.all(batch.map((t) => singleFile(join(dir, name(t)))));
    batch.forEach((t, k) => ok[k] && out.push(t));
  }
  return out;
}

async function listDir(path: string, max: number): Promise<Dirent[]> {
  const out: Dirent[] = [];
  try {
    const dir = await opendir(path);
    try {
      for await (const e of dir) {
        out.push(e);
        if (out.length >= max) break;
      }
    } finally {
      await dir.close().catch(() => {});
    }
  } catch {}
  return out;
}

/** Run ids whose run file names `date` (YYYY-MM/DD-<runId>.md), newest first. */
async function runIdsOn(root: string, date: string, max: number): Promise<string[]> {
  const month = date.slice(0, 7);
  const day = date.slice(8, 10);
  if (!(await plainDir(join(root, month)))) return [];
  const names = (await listDir(join(root, month), max)).filter((e) => e.isFile() && RUN_NAME_RE.exec(e.name)?.[1] === day).map((e) => e.name);
  return (await filterFiles(join(root, month), names, (n) => n)).map((n) => RUN_NAME_RE.exec(n)![2]!).sort().reverse();
}

// --- the daily file's Sessions section -----------------------------------------------------------

const SESSIONS_HEADING = /^## Sessions[ \t]*$/m;
const LEVEL2 = /^## /m;
/** The heading HistoryWriter.writeSession writes; a recap's own headings are demoted below it. */
const SESSION_HEADING = /^### \d{2}:\d{2} · .*$/gm;

export interface RawSession {
  heading: string;
  body: string;
}

export function splitSessions(daily: string): RawSession[] {
  const start = SESSIONS_HEADING.exec(daily);
  if (!start) return [];
  let section = daily.slice(start.index + start[0].length);
  const next = LEVEL2.exec(section);
  if (next) section = section.slice(0, next.index);
  const heads = [...section.matchAll(SESSION_HEADING)];
  return heads.map((h, i) => ({
    heading: h[0].slice(4),
    body: section.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1]!.index : section.length).trim(),
  }));
}

// --- run summaries from run files --------------------------------------------------------------

/**
 * A run known only from its history file (older than the run index window): kind, agent and status from the
 * file's header, startedAt from the run id's own timestamp. Null when the header doesn't read as one.
 */
export async function historyRunSummary(root: string, rel: string, runId: string): Promise<RunSummary | null> {
  const read = await readHistoryFile(root, rel, RUN_HEADER_MAX);
  const at = runIdTime(runId);
  if (!read || !at) return null;
  const head = read.text.split("\n## Transcript")[0]!;
  const title = /^# (\S+) run ([0-9A-HJKMNP-TV-Z]{26})$/m.exec(head);
  const status = /^- \*\*Status:\*\* (\S+)$/m.exec(head)?.[1];
  if (!title || title[2] !== runId || !status || !(RUN_STATUSES as readonly string[]).includes(status)) return null;
  const kind = (RUN_KINDS as readonly string[]).includes(title[1]!) ? (title[1] as RunKind) : "agent";
  const agent = /^- \*\*Agent:\*\* [^/\n]+ \/ (.+)$/m.exec(head)?.[1] ?? kind;
  const parent = /^- \*\*Parent:\*\* \[?([0-9A-HJKMNP-TV-Z]{26})\b/m.exec(head)?.[1];
  const agentName = safeText(agent, 256, { oneLine: true });
  const summary: RunSummary = {
    runId,
    ...(parent ? { parentRunId: parent } : {}),
    kind,
    agentName,
    ...(kind === "job" && /^job:[a-z0-9-]{1,64}$/.test(agentName) ? { jobName: agentName.slice(4) } : {}),
    title: "",
    status: status as RunStatus,
    startedAt: at.toISOString(),
  };
  return runSummary.safeParse(summary).success ? summary : null;
}

/** "YYYY-MM/DD-<runId>.md" when that file exists as a readable history file. */
export async function existingRunFile(root: string, rel: string): Promise<boolean> {
  const opened = await openHistoryFile(root, rel);
  if (!opened) return false;
  await opened.fh.close();
  return true;
}

// --- RPC handlers ----------------------------------------------------------------------------------

export interface HistoryReadOptions {
  principalId: string;
  home: string;
  stateDir: string;
}

function checkPrincipal(opts: HistoryReadOptions, got: string): void {
  if (got !== opts.principalId) throw new Error(`principal mismatch: this workspace serves ${opts.principalId}, got ${got}`);
}

export async function historyDays(opts: HistoryReadOptions, p: unknown): Promise<HistoryDaysResult> {
  const params = historyDaysParams.parse(p);
  checkPrincipal(opts, params.principalId);
  const root = await historyRoot(opts.home);
  if (!root) return { days: [], before: null };
  const days = new Map<string, { daily: boolean; runs: number }>();
  const day = (date: string) => days.get(date) ?? days.set(date, { daily: false, runs: 0 }).get(date)!;
  let budget = DAYS_SCAN_MAX;
  const months: string[] = [];
  const dailies: string[] = [];
  for (const e of await listDir(root, DIR_ENTRIES_MAX)) {
    const daily = DAILY_FILE_RE.exec(e.name);
    if (daily && e.isFile() && isCalendarDate(daily[1]!)) dailies.push(daily[1]!);
    else if (MONTH_RE.test(e.name) && e.isDirectory()) months.push(e.name);
  }
  for (const date of await filterFiles(root, dailies, (d) => `${d}.md`)) day(date).daily = true;
  budget -= DIR_ENTRIES_MAX;
  for (const month of months.sort().reverse()) {
    if (params.before && month > params.before.slice(0, 7)) continue;
    if (budget <= 0 || !(await plainDir(join(root, month)))) continue;
    const entries = await listDir(join(root, month), Math.min(DIR_ENTRIES_MAX, budget));
    budget -= entries.length;
    const names = entries.filter((e) => e.isFile() && RUN_NAME_RE.test(e.name) && isCalendarDate(`${month}-${e.name.slice(0, 2)}`)).map((e) => e.name);
    for (const n of await filterFiles(join(root, month), names, (x) => x)) day(`${month}-${n.slice(0, 2)}`).runs++;
  }
  const dates = [...days.keys()].filter((d) => !params.before || d < params.before).sort().reverse();
  const page = dates.slice(0, params.limit);
  const out: HistoryDaysResult["days"] = [];
  for (const date of page) {
    const d = days.get(date)!;
    const read = d.daily ? await readHistoryFile(root, `${date}.md`) : null;
    out.push({ date, runs: d.runs, sessions: read ? splitSessions(read.text).length : 0 });
  }
  return historyDaysResult.parse({ days: out, before: dates.length > page.length ? page.at(-1)! : null });
}

export async function historyDay(opts: HistoryReadOptions, p: unknown): Promise<HistoryDayResult> {
  const { principalId, date } = historyDayParams.parse(p);
  checkPrincipal(opts, principalId);
  const root = await historyRoot(opts.home);
  if (!root) return { found: false };
  const daily = await readHistoryFile(root, `${date}.md`);
  const ids = await runIdsOn(root, date, DIR_ENTRIES_MAX);
  if (!daily && ids.length === 0) return { found: false };

  let truncated = (daily?.truncated ?? false) || ids.length > HISTORY_DAY_RUNS_MAX;
  const index = ids.length ? await scanRunIndex(runLogPath(opts.stateDir)) : null;
  const runs: RunSummary[] = [];
  for (const runId of ids.slice(0, HISTORY_DAY_RUNS_MAX)) {
    const rec = index?.runs.get(runId);
    const summary = rec ? toRunSummary(rec) : await historyRunSummary(root, `${date.slice(0, 7)}/${date.slice(8)}-${runId}.md`, runId);
    if (summary) runs.push(summary);
  }

  let bytes = Buffer.byteLength(JSON.stringify({ found: true, date, sessions: [], runs, truncated: false }));
  const sessions: { heading: string; markdown: string }[] = [];
  for (const s of daily ? splitSessions(daily.text) : []) {
    if (sessions.length >= HISTORY_DAY_SESSIONS_MAX) {
      truncated = true;
      break;
    }
    const item = { heading: safeText(s.heading, 300, { oneLine: true }), markdown: safeText(s.body, HISTORY_RECAP_MAX) };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > DAY_BUDGET) {
      truncated = true;
      break;
    }
    bytes += size;
    sessions.push(item);
    // Each recap redacts up to 32k chars; let other requests run between them.
    await new Promise<void>((r) => setImmediate(r));
  }
  return historyDayResult.parse({ found: true, date, sessions, runs, truncated });
}

export function historyHandlers(opts: HistoryReadOptions): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    [RPC_METHODS.historyDays]: (p) => historyDays(opts, p),
    [RPC_METHODS.historyDay]: (p) => historyDay(opts, p),
  };
}
