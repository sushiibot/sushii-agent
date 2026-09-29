import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "./ulid.ts";

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

/** Lines of `path` from last to first, read in fixed-size chunks so a large file never loads whole. */
export function* tailLines(path: string, chunkSize = CHUNK): Generator<string> {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
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

  constructor(stateDir: string, opts: { newId?: () => string; now?: () => Date } = {}) {
    this.path = runLogPath(stateDir);
    this.newId = opts.newId ?? ulid;
    this.now = opts.now ?? (() => new Date());
  }

  startRun(input: StartRunInput): string {
    const record: RunRecord = {
      runId: this.newId(),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
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

  // One write per record; a torn tail left by a crash gets a newline first so this record stays parseable.
  private append(record: RunRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, "a+");
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
