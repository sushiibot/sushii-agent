import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { JOB_NAME_RE, RUN_ID_RE, RUN_RESULT_SUMMARY_MAX, RUN_STATUSES, RUN_TITLE_MAX, ID_MAX, runSummary, type RunKind, type RunSummary } from "../orchestration/contracts.ts";
import { FLUSH_MARKER } from "./memoryFlush.ts";
import { REDACTED, redact } from "./secretPatterns.ts";
import { sessionRoots } from "./sessionPaths.ts";
import { TURN_ID_RE, type RunRecord } from "./runLog.ts";

// The one reader of the run index and session transcripts, shared by the ws-runs CLI and the host's
// runs/* handlers. Everything here is agent-writable: paths are confined, reads are bounded, and every
// text that leaves goes through `safeText`.

// --- bounded, redacted text ----------------------------------------------------------------------

const TOKEN_CHARS = "A-Za-z0-9_.+/=~-";
/** Longest unbroken token kept: several secret patterns are quadratic in the length of such a run. */
const TOKEN_RUN_MAX = 256;
const LONG_TOKEN = new RegExp(`(?<![${TOKEN_CHARS}])[${TOKEN_CHARS}]{${TOKEN_RUN_MAX + 1},}`, "g");
const TOKEN_TAIL = new RegExp(`[${TOKEN_CHARS}]+$`);
// C0/C1 controls blow up JSON escaping; bidi overrides and line separators can disguise text on screen.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
export const SLICE_SLACK = 1024;

/** Cuts to `max` UTF-16 units (what zod's `.max` counts), never through a surrogate pair. */
export function clipUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

/** Redacted (before clipping, so a cut can't leave a secret fragment too short to match), control-free, at most `max` units. */
export function safeText(raw: string, max: number, opts: { oneLine?: boolean } = {}): string {
  const cut = raw.length > max + SLICE_SLACK;
  let s = cut ? raw.slice(0, max + SLICE_SLACK) : raw;
  s = s.replace(CONTROL, opts.oneLine ? " " : "");
  if (opts.oneLine) s = s.replace(/\s+/g, " ").trim();
  s = redact(s.replace(LONG_TOKEN, REDACTED));
  // The slice end can cut through a secret whose prefix matches no pattern; drop the token run it ends in.
  if (cut) s = s.replace(TOKEN_TAIL, "");
  return clipUnits(s, max);
}

const str = (v: unknown): v is string => typeof v === "string";

// --- bounded line readers --------------------------------------------------------------------------

/** Splits chunks read from the end of a file backwards into lines, newest first; lines over `maxLine` bytes are dropped. */
export class TailSplitter {
  private carry: Buffer[] = [];
  private carryLen = 0;
  private dropping = false;
  constructor(private readonly maxLine: number) {}

  /** `chunk` immediately precedes everything pushed so far. Returns the complete lines it closes, newest first. */
  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let end = chunk.length;
    while (end > 0) {
      const nl = chunk.lastIndexOf(0x0a, end - 1);
      if (nl === -1) break;
      const piece = chunk.subarray(nl + 1, end);
      if (this.dropping) this.dropping = false;
      else this.emit(piece, out);
      this.carry = [];
      this.carryLen = 0;
      end = nl;
    }
    this.hold(chunk.subarray(0, end));
    return out;
  }

  /** The first line of the file, once the start has been reached. */
  finish(): string[] {
    const out: string[] = [];
    if (!this.dropping) this.emit(Buffer.alloc(0), out);
    this.carry = [];
    this.carryLen = 0;
    return out;
  }

  private emit(piece: Buffer, out: string[]): void {
    if (piece.length + this.carryLen > this.maxLine) return;
    const line = (this.carryLen ? Buffer.concat([piece, ...this.carry]) : piece).toString("utf8");
    if (line) out.push(line);
  }

  private hold(piece: Buffer): void {
    if (this.dropping || piece.length === 0) return;
    this.carry.unshift(piece);
    this.carryLen += piece.length;
    if (this.carryLen > this.maxLine) {
      this.carry = [];
      this.carryLen = 0;
      this.dropping = true;
    }
  }
}

export interface TailBounds {
  maxBytes: number;
  maxLine: number;
  chunk?: number;
}

/** Lines of an open file from last to first. `state.truncated` is set when `maxBytes` stopped the read before the start. */
export async function* tailLinesOf(fh: FileHandle, size: number, b: TailBounds, state: { truncated: boolean }): AsyncGenerator<string> {
  const chunkSize = b.chunk ?? 1024 * 1024;
  const split = new TailSplitter(b.maxLine);
  let pos = size;
  let read = 0;
  while (pos > 0) {
    if (read >= b.maxBytes) {
      state.truncated = true;
      return;
    }
    const len = Math.min(chunkSize, pos, b.maxBytes - read);
    pos -= len;
    read += len;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    for (const line of split.push(buf.subarray(0, bytesRead))) yield line;
  }
  for (const line of split.finish()) yield line;
}

export function* tailLinesOfSync(fd: number, size: number, b: TailBounds, state: { truncated: boolean }): Generator<string> {
  const chunkSize = b.chunk ?? 64 * 1024;
  const split = new TailSplitter(b.maxLine);
  let pos = size;
  let read = 0;
  while (pos > 0) {
    if (read >= b.maxBytes) {
      state.truncated = true;
      return;
    }
    const len = Math.min(chunkSize, pos, b.maxBytes - read);
    pos -= len;
    read += len;
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, pos);
    for (const line of split.push(buf.subarray(0, n))) yield line;
  }
  for (const line of split.finish()) yield line;
}

// O_NONBLOCK: a FIFO planted in place of a file would otherwise block the open until a writer shows up.
export const SAFE_OPEN = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The path an open fd really names (Linux /proc), or null where /proc is unavailable. */
export function fdPath(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

// --- the run index ---------------------------------------------------------------------------------

export const RUN_SCAN_MAX_LINES = 20_000;
export const RUN_SCAN_MAX_BYTES = 16 * 1024 * 1024;
/** A record is a few KiB at most (task ≤ 500, result ≤ 1000 chars); anything longer is not one the host wrote. */
const RUN_LINE_MAX = 64 * 1024;

export interface RunIndex {
  /** The latest record per runId within the scan window, newest record first. */
  runs: Map<string, RunRecord>;
  /** The window ended before the start of the file: older runs exist that this scan can't see. */
  truncated: boolean;
}

function parseRecord(line: string): RunRecord | null {
  if (!line.includes('"runId"')) return null;
  try {
    const r = JSON.parse(line) as Partial<RunRecord>;
    return r && typeof r === "object" && str(r.runId) && str(r.status) && str(r.startedAt) ? (r as RunRecord) : null;
  } catch {
    return null;
  }
}

class RunIndexBuilder {
  readonly index: RunIndex = { runs: new Map(), truncated: false };
  private lines = 0;
  /** False once the line bound is hit. */
  add(line: string): boolean {
    if (++this.lines > RUN_SCAN_MAX_LINES) {
      this.index.truncated = true;
      return false;
    }
    const rec = parseRecord(line);
    if (rec && !this.index.runs.has(rec.runId)) this.index.runs.set(rec.runId, rec);
    return true;
  }
}

const empty = (): RunIndex => ({ runs: new Map(), truncated: false });

/** The bounded tail of runs.jsonl. A missing, linked or non-regular index reads as empty. */
export async function scanRunIndex(path: string): Promise<RunIndex> {
  let fh: FileHandle;
  try {
    fh = await open(path, SAFE_OPEN);
  } catch {
    return empty();
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1) return empty();
    const b = new RunIndexBuilder();
    const state = { truncated: false };
    for await (const line of tailLinesOf(fh, st.size, { maxBytes: RUN_SCAN_MAX_BYTES, maxLine: RUN_LINE_MAX, chunk: 256 * 1024 }, state)) {
      if (!b.add(line)) break;
    }
    if (state.truncated) b.index.truncated = true;
    return b.index;
  } finally {
    await fh.close();
  }
}

/** `scanRunIndex` for the CLI, which runs in its own process and stays synchronous. */
export function scanRunIndexSync(path: string): RunIndex {
  let fd: number;
  try {
    fd = openSync(path, SAFE_OPEN);
  } catch {
    return empty();
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return empty();
    const b = new RunIndexBuilder();
    const state = { truncated: false };
    for (const line of tailLinesOfSync(fd, st.size, { maxBytes: RUN_SCAN_MAX_BYTES, maxLine: RUN_LINE_MAX }, state)) {
      if (!b.add(line)) break;
    }
    if (state.truncated) b.index.truncated = true;
    return b.index;
  } finally {
    closeSync(fd);
  }
}

// --- run records → wire summaries ----------------------------------------------------------------

/** Same rule as the history writer's: main and topic:<id> → chat (or flush), main:rotate → rotate, job:<name> → job, a parent → subagent. */
export function runKindOf(rec: Pick<RunRecord, "agentName" | "parentRunId" | "task">): RunKind {
  if (rec.agentName === "main" || /^topic:[A-Za-z0-9_-]{1,80}$/.test(rec.agentName)) return str(rec.task) && rec.task.startsWith(FLUSH_MARKER) ? "flush" : "chat";
  if (rec.agentName === "main:rotate") return "rotate";
  if (str(rec.agentName) && rec.agentName.startsWith("job:")) return "job";
  return rec.parentRunId ? "subagent" : "agent";
}

/** Older topic records predate conversationId; their stable topic agent name identifies the conversation. */
export function runConversationOf(rec: Pick<RunRecord, "conversationId" | "agentName">): string | undefined {
  if (str(rec.conversationId) && /^[A-Za-z0-9_-]{1,80}$/.test(rec.conversationId)) return rec.conversationId;
  const topic = /^topic:([A-Za-z0-9_-]{1,80})$/.exec(rec.agentName);
  return topic?.[1];
}

/** `[web:… 2026-…]` and similar: the stamp every chat message starts with. */
export function stripHeader(text: string): string {
  return text.replace(/^\[[^\]\n]*\]\n?/, "");
}

const STAMP_MAX = 40;
const isStamp = (v: unknown): v is string => str(v) && v.length <= STAMP_MAX && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function usageOf(u: unknown): RunSummary["usage"] {
  if (!u || typeof u !== "object") return undefined;
  const r = u as Record<string, unknown>;
  if (!isCount(r.inputTokens) || !isCount(r.outputTokens)) return undefined;
  return {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    ...(typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? { costUsd: r.costUsd } : {}),
    ...(str(r.model) && r.model ? { model: safeText(r.model, ID_MAX, { oneLine: true }) } : {}),
  };
}

/** The wire summary of a record, or null when the record can't be shown faithfully (a forged or garbled line). */
export function toRunSummary(rec: RunRecord): RunSummary | null {
  if (!RUN_ID_RE.test(rec.runId) || !(RUN_STATUSES as readonly string[]).includes(rec.status) || !isStamp(rec.startedAt)) return null;
  if (!str(rec.agentName)) return null;
  const parentRunId = str(rec.parentRunId) && RUN_ID_RE.test(rec.parentRunId) ? rec.parentRunId : undefined;
  const kind = runKindOf({ agentName: rec.agentName, task: rec.task, ...(parentRunId ? { parentRunId } : {}) });
  const jobName = kind === "job" ? rec.agentName.slice(4) : undefined;
  const task = str(rec.task) ? rec.task : "";
  const usage = usageOf(rec.usage);
  const summary: RunSummary = {
    runId: rec.runId,
    ...(parentRunId ? { parentRunId } : {}),
    ...(str(rec.turnId) && TURN_ID_RE.test(rec.turnId) ? { turnId: rec.turnId } : {}),
    ...(runConversationOf(rec) ? { conversationId: runConversationOf(rec) } : {}),
    ...(str(rec.repo) ? { repo: safeText(rec.repo, ID_MAX, { oneLine: true }) } : {}),
    kind,
    agentName: safeText(rec.agentName, ID_MAX, { oneLine: true }),
    ...(jobName && JOB_NAME_RE.test(jobName) ? { jobName } : {}),
    title: kind === "flush" ? "memory flush" : safeText(stripHeader(task), RUN_TITLE_MAX, { oneLine: true }),
    status: rec.status,
    startedAt: rec.startedAt,
    ...(isStamp(rec.endedAt) ? { endedAt: rec.endedAt } : {}),
    ...(usage ? { usage } : {}),
    ...(str(rec.resultSummary) && rec.resultSummary ? { resultSummary: safeText(rec.resultSummary, RUN_RESULT_SUMMARY_MAX, { oneLine: true }) } : {}),
  };
  return runSummary.safeParse(summary).success ? summary : null;
}

/** The ULID's own timestamp: when the host minted the id, i.e. when the run started. */
export function runIdTime(runId: string): Date | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = 0;
  for (const c of runId.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(c);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- confined session file access ----------------------------------------------------------------

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** The session roots under the given agent dirs. A root that is itself a symlink could point anywhere, e.g. `<agentDir>/chat -> <agentDir>`. */
export function realRoots(agentDirs: string[]): string[] {
  const roots: string[] = [];
  for (const r of agentDirs.flatMap(sessionRoots)) {
    try {
      const st = lstatSync(r);
      if (st.isDirectory() && !st.isSymbolicLink()) roots.push(realpathSync(r));
    } catch {}
  }
  return [...new Set(roots)];
}

/** A Pi session header is one short line. */
const HEADER_MAX = 64 * 1024;

function isSessionHeader(buf: Buffer): boolean {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return false;
  const header = parseEntry(buf.subarray(0, nl).toString("utf8")) as { type?: unknown } | null;
  return header?.type === "session";
}

/** Lines from the start of a file, read in chunks. */
export function* headLines(path: string): Generator<string> {
  const fd = openSync(path, SAFE_OPEN);
  try {
    const buf = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      pos += n;
      let start = 0;
      for (let nl = buf.indexOf(0x0a, 0); nl !== -1 && nl < n; nl = buf.indexOf(0x0a, start)) {
        parts.push(buf.subarray(start, nl));
        const line = Buffer.concat(parts).toString("utf8");
        parts.length = 0;
        if (line) yield line;
        start = nl + 1;
      }
      if (start < n) parts.push(Buffer.from(buf.subarray(start, n)));
    }
    const last = Buffer.concat(parts).toString("utf8");
    if (last) yield last;
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens `file` when it is a regular, singly linked Pi session file under the session roots, checking the
 * open fd itself (type, links, real path, header), so callers read exactly the file that was checked.
 */
export function openConfinedSessionSync(file: string, roots: string[]): { fd: number; real: string; size: number } | null {
  if (!str(file) || !file || file.includes("\0")) return null;
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return null;
  }
  if (!real.endsWith(".jsonl") || !roots.some((r) => inside(real, r))) return null;
  let fd: number;
  try {
    fd = openSync(real, SAFE_OPEN);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("refused");
    const now = fdPath(fd);
    if (now !== null && now !== real) throw new Error("refused");
    const buf = Buffer.alloc(Math.min(HEADER_MAX, st.size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (!isSessionHeader(buf.subarray(0, n))) throw new Error("refused");
    return { fd, real, size: st.size };
  } catch {
    closeSync(fd);
    return null;
  }
}

/** The real path of `file` when it is a Pi session file under the session roots, else null. */
export function confineSessionFile(file: string, roots: string[]): string | null {
  const opened = openConfinedSessionSync(file, roots);
  if (!opened) return null;
  closeSync(opened.fd);
  return opened.real;
}

export type SessionState = "ok" | "missing" | "outside" | "not-session";

export interface OpenedSession {
  state: "ok";
  fh: FileHandle;
  size: number;
}

/**
 * Opens a run's session file for reading when it is a regular, singly linked Pi session file under the
 * roots. The path is checked again on the open fd, so a swap between the check and the open is caught.
 */
export async function openSession(file: unknown, roots: string[]): Promise<OpenedSession | { state: Exclude<SessionState, "ok"> }> {
  if (!str(file) || !file || file.includes("\0")) return { state: "missing" };
  let real: string;
  try {
    real = await realpath(file);
  } catch (err) {
    return { state: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "outside" };
  }
  if (!roots.some((r) => inside(real, r))) return { state: "outside" };
  if (!real.endsWith(".jsonl")) return { state: "not-session" };
  let fh: FileHandle;
  try {
    fh = await open(real, SAFE_OPEN);
  } catch (err) {
    return { state: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "not-session" };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1) throw new Refused("not-session");
    const now = fdPath(fh.fd);
    if (now !== null && (now !== real || !roots.some((r) => inside(now, r)))) throw new Refused("outside");
    const buf = Buffer.alloc(Math.min(HEADER_MAX, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (!isSessionHeader(buf.subarray(0, bytesRead))) throw new Refused("not-session");
    return { state: "ok", fh, size: st.size };
  } catch (err) {
    await fh.close();
    if (err instanceof Refused) return { state: err.state };
    return { state: "not-session" };
  }
}

class Refused extends Error {
  constructor(readonly state: Exclude<SessionState, "ok">) {
    super(state);
  }
}

// --- session entries -------------------------------------------------------------------------------

export interface Entry {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
    details?: unknown;
  };
  summary?: string;
  customType?: string;
  content?: unknown;
}

export function parseEntry(line: string): Entry | null {
  try {
    const e = JSON.parse(line) as Entry;
    return e && typeof e === "object" ? e : null;
  } catch {
    return null;
  }
}

/** Text parts only: image data never leaves. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

export const SESSION_READ_MAX_BYTES = 64 * 1024 * 1024;
/** Entries kept from one window, newest first; a window of many tiny entries stops here. */
export const WINDOW_ENTRIES_MAX = 20_000;
/** A line with inline images can run to several MiB; one past this is skipped rather than parsed. */
const SESSION_LINE_MAX = 16 * 1024 * 1024;

/**
 * The entries stamped within [from, to], in file order, each passed through `slim` as it is read so a
 * window never holds whole image or file payloads. Reads from the tail and stops at the first entry before
 * `from` or after `SESSION_READ_MAX_BYTES`.
 */
export async function entriesInWindow<T>(s: OpenedSession, from: number, to: number, slim: (e: Entry) => T | null, maxEntries = WINDOW_ENTRIES_MAX): Promise<{ entries: T[]; truncated: boolean }> {
  const out: T[] = [];
  const state = { truncated: false };
  for await (const line of tailLinesOf(s.fh, s.size, { maxBytes: SESSION_READ_MAX_BYTES, maxLine: SESSION_LINE_MAX }, state)) {
    const entry = parseEntry(line);
    if (!entry || !str(entry.timestamp) || entry.type === "session") continue;
    const t = Date.parse(entry.timestamp);
    if (Number.isNaN(t)) continue;
    if (t < from) break;
    if (t > to) continue;
    const slimmed = slim(entry);
    if (slimmed === null) continue;
    if (out.length >= maxEntries) {
      state.truncated = true;
      break;
    }
    out.push(slimmed);
  }
  return { entries: out.reverse(), truncated: state.truncated };
}
