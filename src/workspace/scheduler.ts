import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic } from "./files.ts";

// No logger import: the ws-consolidate CLI uses this module and pino would write JSON onto its stdout.

export type JobTrigger = "daily" | "catchup" | "manual";

export interface JobContext {
  trigger: JobTrigger;
  /** Manual runs skip the job's own gate (e.g. the consolidation threshold), never its safety checks. */
  force: boolean;
}

export interface JobOutcome {
  status: string;
  summary?: string;
}

export interface ScheduledJob {
  /** Also the scheduler.json key and the manual request file name; [a-z0-9-] only. */
  name: string;
  run(ctx: JobContext): Promise<JobOutcome>;
}

export interface JobRunState {
  lastRunAt: string;
  lastTrigger: JobTrigger;
  lastStatus: string;
  lastSummary?: string;
}

export interface SchedulerState {
  jobs: Record<string, JobRunState>;
}

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

export interface SchedulerOptions {
  stateDir: string;
  /** Local wall-clock time of the daily run, "HH:MM". */
  at: string;
  /** IANA zone for `at`. */
  tz: string;
  now?: () => Date;
  /** How often due times and manual requests are checked. */
  pollMs?: number;
  log?: Log;
}

const DAY_MS = 24 * 60 * 60_000;
const JOB_NAME = /^[a-z0-9-]+$/;
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function schedulerStatePath(stateDir: string): string {
  return join(stateDir, "scheduler.json");
}

export function requestDir(stateDir: string): string {
  return join(stateDir, "requests");
}

export function requestPath(stateDir: string, job: string): string {
  if (!JOB_NAME.test(job)) throw new Error(`invalid job name: ${job}`);
  return join(requestDir(stateDir), `${job}.request`);
}

export function readSchedulerState(stateDir: string): SchedulerState {
  const state = readJson<Partial<SchedulerState>>(schedulerStatePath(stateDir));
  return { jobs: state?.jobs && typeof state.jobs === "object" ? state.jobs : {} };
}

/** Queues a manual run of `job`; the running scheduler picks it up on its next poll. */
export function requestRun(stateDir: string, job: string, now: Date = new Date()): string {
  const path = requestPath(stateDir, job);
  writeFileAtomic(path, `${JSON.stringify({ requestedAt: now.toISOString() })}\n`);
  return path;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidAt(at: string): boolean {
  return AT.test(at);
}

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallTime(date: Date, tz: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

function offsetMs(date: Date, tz: string): number {
  const w = wallTime(date, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` happens; a time skipped by DST lands just after the gap. */
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(first), tz);
  return second;
}

/** The latest daily `at` in `tz` at or before `now`. */
export function lastOccurrence(now: Date, at: string, tz: string): Date {
  const match = AT.exec(at);
  if (!match) throw new Error(`invalid time of day: ${at}`);
  const h = Number(match[1]);
  const mi = Number(match[2]);
  const w = wallTime(now, tz);
  const today = zonedToUtc(w.y, w.m, w.d, h, mi, tz);
  if (today <= now.getTime()) return new Date(today);
  const y = new Date(Date.UTC(w.y, w.m - 1, w.d - 1));
  return new Date(zonedToUtc(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), h, mi, tz));
}

/**
 * Minimal in-process daily scheduler: each registered job runs at `at` local time, once on startup when its
 * last run is over 24 h old (or never happened), and on demand via a request file. One run per job at a time.
 */
export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly inFlight = new Map<string, Promise<JobOutcome | null>>();
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheck: Date | null = null;
  private stopped = false;

  constructor(private readonly opts: SchedulerOptions) {
    if (!isValidAt(opts.at)) throw new Error(`invalid time of day: ${opts.at}`);
    if (!isValidTimeZone(opts.tz)) throw new Error(`invalid time zone: ${opts.tz}`);
    this.now = opts.now ?? (() => new Date());
  }

  register(job: ScheduledJob): void {
    if (!JOB_NAME.test(job.name)) throw new Error(`invalid job name: ${job.name}`);
    if (this.jobs.has(job.name)) throw new Error(`job already registered: ${job.name}`);
    this.jobs.set(job.name, job);
  }

  /** Starts polling and any startup catch-up; resolves when the catch-up runs finish. */
  start(): Promise<void> {
    if (this.timer || this.stopped) return Promise.resolve();
    const now = this.now();
    this.lastCheck = now;
    const state = readSchedulerState(this.opts.stateDir);
    const runs: Promise<unknown>[] = [];
    for (const name of this.jobs.keys()) {
      const last = state.jobs[name]?.lastRunAt;
      if (!last || now.getTime() - Date.parse(last) > DAY_MS) runs.push(this.runJob(name, { trigger: "catchup", force: false }));
    }
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 30_000);
    this.timer.unref?.();
    return Promise.all(runs).then(() => {});
  }

  /** One poll: starts manual requests and daily runs that fell due since the last poll; resolves when they finish. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const since = this.lastCheck ?? now;
    this.lastCheck = now;
    const runs: Promise<unknown>[] = [];

    for (const name of this.takeRequests()) runs.push(this.runJob(name, { trigger: "manual", force: true }));

    const due = lastOccurrence(now, this.opts.at, this.opts.tz);
    if (due > since) {
      const state = readSchedulerState(this.opts.stateDir);
      for (const name of this.jobs.keys()) {
        const last = state.jobs[name]?.lastRunAt;
        if (!last || Date.parse(last) < due.getTime()) runs.push(this.runJob(name, { trigger: "daily", force: false }));
      }
    }
    await Promise.all(runs);
  }

  /** Runs `name` now, or joins the run already in flight. Null when the job threw. */
  runJob(name: string, ctx: JobContext): Promise<JobOutcome | null> {
    const existing = this.inFlight.get(name);
    if (existing) return existing;
    const job = this.jobs.get(name);
    if (!job) return Promise.reject(new Error(`unknown job: ${name}`));
    const started = this.now();
    const run = (async () => {
      let outcome: JobOutcome | null = null;
      try {
        outcome = await job.run(ctx);
        this.opts.log?.info({ job: name, trigger: ctx.trigger, status: outcome.status }, "scheduled job finished");
      } catch (err) {
        this.opts.log?.error({ err, job: name, trigger: ctx.trigger }, "scheduled job failed");
      }
      // Recorded after a failure too, so a job that throws retries tomorrow rather than on every restart.
      this.record(name, {
        lastRunAt: started.toISOString(),
        lastTrigger: ctx.trigger,
        lastStatus: outcome?.status ?? "error",
        ...(outcome?.summary ? { lastSummary: outcome.summary } : {}),
      });
      return outcome;
    })().finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, run);
    return run;
  }

  /** Stops polling and waits up to `waitMs` for runs in flight; one cut short is caught up on the next start. */
  async stop(waitMs = 5000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    await Promise.race([Promise.allSettled([...this.inFlight.values()]), timeout]);
    clearTimeout(timer);
  }

  private takeRequests(): string[] {
    const dir = requestDir(this.opts.stateDir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const taken: string[] = [];
    for (const file of names) {
      if (!file.endsWith(".request")) continue;
      const name = file.slice(0, -".request".length);
      // Unlinking claims the request, so one file never starts two runs.
      try {
        unlinkSync(join(dir, file));
      } catch {
        continue;
      }
      if (this.jobs.has(name)) taken.push(name);
      else this.opts.log?.warn({ job: name }, "manual run requested for an unknown job");
    }
    return taken;
  }

  private record(name: string, run: JobRunState): void {
    try {
      mkdirSync(this.opts.stateDir, { recursive: true });
      const state = readSchedulerState(this.opts.stateDir);
      state.jobs[name] = run;
      writeFileAtomic(schedulerStatePath(this.opts.stateDir), `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      this.opts.log?.error({ err, job: name }, "failed to record a scheduled run");
    }
  }
}
