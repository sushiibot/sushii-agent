import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "./ulid.ts";
import type { RotationRecord } from "./personalSession.ts";

// No logger import: the ws-runs CLI uses this module and pino would write JSON onto its stdout.

export type RunStatus = "running" | "done" | "failed" | "aborted" | "timeout";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** The model of the run's last reply: `chatgpt/<id>` under Sign in with ChatGPT, else the OpenRouter id. */
  model?: string;
}

/** One line of runs.jsonl. */
export interface RunRecord {
  runId: string;
  parentRunId?: string;
  /** The Main turn a main run answers: the join key to the bot's replies and files. Absent on older records. */
  turnId?: string;
  /** "main" | agent def name | "job:<name>" */
  agentName: string;
  task: string;
  sessionFile: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  usage?: RunUsage;
  resultSummary?: string;
}

export const TASK_MAX = 500;
export const RESULT_SUMMARY_MAX = 1000;
const CHUNK = 64 * 1024;

export function runLogPath(stateDir: string): string {
  return join(stateDir, "runs.jsonl");
}

export interface StartRunInput {
  agentName: string;
  parentRunId?: string;
  turnId?: string;
  task: string;
  sessionFile: string;
  /** Defaults to now; pass the moment the run actually began when the start line is written late. */
  startedAt?: Date;
}

export interface EndRunInput {
  status: Exclude<RunStatus, "running">;
  usage?: RunUsage;
  resultSummary?: string;
}

export interface ListRunsQuery {
  limit?: number;
  agentName?: string;
  parentRunId?: string;
  /** Only runs started at or after this time. */
  since?: Date;
}

/** What the main-turn observer, subagents and scheduled jobs use to log their runs. */
export interface RunRecorder {
  startRun(input: StartRunInput): string;
  endRun(runId: string, end: EndRunInput): void;
  listRuns(query?: ListRunsQuery): RunRecord[];
  getRun(runId: string): RunRecord | null;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function normalizeUsage(usage: RunUsage | undefined): RunUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.costUsd && usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
    ...(usage.model ? { model: usage.model } : {}),
  };
}

function parseRecord(line: string): RunRecord | null {
  if (!line.trim()) return null;
  try {
    const r = JSON.parse(line) as Partial<RunRecord>;
    return typeof r?.runId === "string" && typeof r.status === "string" && typeof r.startedAt === "string" ? (r as RunRecord) : null;
  } catch {
    return null;
  }
}

// The state dir is agent-writable: a FIFO, symlink or hardlink planted at runs.jsonl must never block or
// redirect the host. O_NONBLOCK keeps a FIFO open from waiting for a writer.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
// Read-write, not write-only: append checks the last byte for a torn line first.
const APPEND_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const isPlainFile = (st: { isFile(): boolean; nlink: number }) => st.isFile() && st.nlink === 1;

/** Lines of `path` from last to first, read in fixed-size chunks so a large file never loads whole. Anything but a regular, singly linked file reads as empty. */
export function* tailLines(path: string, chunkSize = CHUNK): Generator<string> {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return;
  }
  try {
    if (!isPlainFile(fstatSync(fd))) return;
    let pos = fstatSync(fd).size;
    let carry: Buffer = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      let data: Buffer = Buffer.concat([buf, carry]);
      let nl = data.lastIndexOf(0x0a);
      while (nl !== -1) {
        const line = data.subarray(nl + 1).toString("utf8");
        if (line) yield line;
        data = data.subarray(0, nl);
        nl = data.lastIndexOf(0x0a);
      }
      carry = data;
    }
    if (carry.length) yield carry.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Latest record per runId, newest first. */
export function* latestRuns(path: string): Generator<RunRecord> {
  const seen = new Set<string>();
  for (const line of tailLines(path)) {
    const rec = parseRecord(line);
    if (!rec || seen.has(rec.runId)) continue;
    seen.add(rec.runId);
    yield rec;
  }
}

/** Append-only run index; a start line at spawn, a full end line at settle, readers keep the last line per runId. */
export class RunLog implements RunRecorder {
  readonly path: string;
  private readonly open = new Map<string, RunRecord>();
  private readonly newId: () => string;
  private readonly now: () => Date;

  private readonly warn: (obj: object, msg: string) => void;

  constructor(stateDir: string, opts: { newId?: () => string; now?: () => Date; warn?: (obj: object, msg: string) => void } = {}) {
    this.path = runLogPath(stateDir);
    this.newId = opts.newId ?? ulid;
    this.now = opts.now ?? (() => new Date());
    this.warn = opts.warn ?? (() => {});
    this.quarantine();
  }

  /** Moves anything but a regular, singly linked file at the log path aside, so the host starts a fresh log. */
  private quarantine(): void {
    try {
      const st = lstatSync(this.path);
      if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1) return;
      const aside = `${this.path}.unsafe-${Date.now()}`;
      renameSync(this.path, aside);
      this.warn({ path: this.path, aside }, "runs.jsonl was not a plain file; moved it aside and started a fresh run log");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.warn({ err, path: this.path }, "could not check runs.jsonl");
    }
  }

  startRun(input: StartRunInput): string {
    const record: RunRecord = {
      runId: this.newId(),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.turnId && TURN_ID_RE.test(input.turnId) ? { turnId: input.turnId } : {}),
      agentName: input.agentName,
      task: clip(input.task, TASK_MAX),
      sessionFile: input.sessionFile,
      startedAt: (input.startedAt ?? this.now()).toISOString(),
      status: "running",
    };
    this.open.set(record.runId, record);
    this.append(record);
    return record.runId;
  }

  endRun(runId: string, end: EndRunInput): void {
    const start = this.open.get(runId) ?? this.getRun(runId);
    if (!start) throw new Error(`endRun: unknown runId ${runId}`);
    this.open.delete(runId);
    const usage = normalizeUsage(end.usage);
    const { usage: _u, resultSummary: _r, endedAt: _e, ...base } = start;
    this.append({
      ...base,
      endedAt: this.now().toISOString(),
      status: end.status,
      ...(usage ? { usage } : {}),
      ...(end.resultSummary ? { resultSummary: clip(end.resultSummary, RESULT_SUMMARY_MAX) } : {}),
    });
  }

  listRuns(query: ListRunsQuery = {}): RunRecord[] {
    const limit = query.limit ?? 20;
    const out: RunRecord[] = [];
    if (limit <= 0) return out;
    const since = query.since?.getTime();
    for (const rec of latestRuns(this.path)) {
      if (query.agentName !== undefined && rec.agentName !== query.agentName) continue;
      if (query.parentRunId !== undefined && rec.parentRunId !== query.parentRunId) continue;
      if (since !== undefined && Date.parse(rec.startedAt) < since) continue;
      out.push(rec);
      if (out.length >= limit) break;
    }
    return out;
  }

  getRun(runId: string): RunRecord | null {
    for (const line of tailLines(this.path)) {
      if (!line.includes(runId)) continue;
      const rec = parseRecord(line);
      if (rec?.runId === runId) return rec;
    }
    return null;
  }

  /**
   * Closes runs a previous process left "running" (it died before they settled). Only the newest
   * `window` records are checked, so startup cost stays bounded.
   */
  reconcileOrphans(window = 500): number {
    let checked = 0;
    const orphans: RunRecord[] = [];
    for (const rec of latestRuns(this.path)) {
      if (++checked > window) break;
      if (rec.status === "running" && !this.open.has(rec.runId)) orphans.push(rec);
    }
    for (const rec of orphans.reverse()) {
      this.open.set(rec.runId, rec);
      this.endRun(rec.runId, { status: "failed", resultSummary: "the workspace restarted before this run settled" });
    }
    return orphans.length;
  }

  private openForAppend(): number {
    for (let attempt = 0; ; attempt++) {
      this.quarantine();
      let fd: number | null = null;
      try {
        fd = openSync(this.path, APPEND_FLAGS, 0o644);
        if (isPlainFile(fstatSync(fd))) return fd;
      } catch (err) {
        if (attempt > 0) throw err;
      }
      if (fd !== null) closeSync(fd);
      if (attempt > 0) throw new Error("runs.jsonl is not a plain file");
    }
  }

  // One write per record; a torn tail left by a crash gets a newline first so this record stays parseable.
  private append(record: RunRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = this.openForAppend();
    try {
      const size = fstatSync(fd).size;
      let prefix = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
      writeSync(fd, `${prefix}${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
  }
}

/** The host's turn ids are ULIDs (PersonalSession's newId); anything else in a record is not one it wrote. */
export const TURN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** An idle rotation as a finished `main:rotate` run: tokens before/after, on the retired session's file. */
export function recordRotation(runs: RunRecorder, r: RotationRecord): string {
  const runId = runs.startRun({
    agentName: "main:rotate",
    task: `idle rotation: ${r.tokensBefore} → ${r.tokensAfter ?? "?"} tokens${r.recapped ? ", recap seeded" : ", no recap"}`,
    sessionFile: r.previousSessionFile,
    startedAt: r.startedAt,
  });
  runs.endRun(runId, { status: "done", resultSummary: `new session ${r.sessionFile}` });
  return runId;
}
