import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic } from "./files.ts";
import { redact } from "./secretPatterns.ts";

// No logger import: the ws-consolidate CLI uses this module and pino would write JSON onto its stdout.

export type JobTrigger = "daily" | "interval" | "catchup" | "manual";

export interface JobContext {
  trigger: JobTrigger;
  /** Manual runs skip the job's own gate (e.g. the consolidation threshold), never its safety checks. */
  force: boolean;
}

export interface JobOutcome {
  status: string;
  summary?: string;
}

/** Local "HH:MM"–"HH:MM" in the scheduler's zone; `end` before `start` wraps midnight. */
export interface ActiveHours {
  start: string;
  end: string;
}

export type JobWhen = { kind: "daily"; at: string } | { kind: "every"; minutes: number };

export interface JobSchedule {
  when: JobWhen;
  active?: ActiveHours;
  /** Never runs on its own; a manual request still runs it. */
  disabled?: boolean;
}

export interface ScheduledJob {
  /** Also the scheduler.json key and the manual request file name; [a-z0-9-] only. */
  name: string;
  /** Own trigger; without one the job runs at the scheduler's daily `at`, with a startup catch-up. */
  schedule?: JobSchedule;
  /** A run past this is reported stuck (once); it is not aborted. Default DEFAULT_MAX_RUN_MS. */
  maxRunMs?: number;
  run(ctx: JobContext): Promise<JobOutcome>;
}

/** One entry of jobs.json, the job list the ws-schedule CLI reads. */
export interface JobIndexEntry {
  name: string;
  schedule: string;
}

export interface JobRunState {
  lastRunAt: string;
  lastTrigger: JobTrigger;
  lastStatus: string;
  lastSummary?: string;
}

/** Set once a failure streak has been reported; cleared by the next success. */
export interface JobAlertState {
  at: string;
  kind: "failed" | "stuck";
}

export interface SchedulerState {
  jobs: Record<string, JobRunState>;
  alerts: Record<string, JobAlertState>;
}

export interface JobAlert {
  job: string;
  kind: "failed" | "stuck" | "recovered";
  trigger: JobTrigger;
  startedAt: Date;
  /** One line, redacted and truncated; on "failed" only. */
  error?: string;
  /** The job's schedule as formatSchedule renders it, e.g. "daily 04:00". */
  schedule: string;
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
  /** At most one "failed"/"stuck" per job per failure streak, and one "recovered" when a success ends it. */
  onJobAlert?: (alert: JobAlert) => void | Promise<void>;
}

const DAY_MS = 24 * 60 * 60_000;
/** A per-job daily run missed by up to this much (a restart across its time) still runs; older is skipped. */
export const DAILY_GRACE_MS = 60 * 60_000;
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 24 * 60;
export const DEFAULT_MAX_RUN_MS = 30 * 60_000;
export const ALERT_ERROR_MAX = 200;
/** Outcome statuses that count as a failed run; "error" is what a thrown run records. */
export const FAILED_STATUSES: readonly string[] = ["error", "failed", "rejected"];
/** Outcome statuses that neither end nor extend a failure streak (e.g. a consolidation skipped on unchanged inputs). */
export const NEUTRAL_STATUSES: readonly string[] = ["skipped", "rate_limited"];
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

export function jobIndexPath(stateDir: string): string {
  return join(stateDir, "jobs.json");
}

/** The job list the running scheduler last wrote, or null before its first start. */
export function readJobIndex(stateDir: string): JobIndexEntry[] | null {
  const index = readJson<{ jobs?: JobIndexEntry[] }>(jobIndexPath(stateDir));
  return Array.isArray(index?.jobs) ? index.jobs : null;
}

export function readSchedulerState(stateDir: string): SchedulerState {
  const state = readJson<Partial<SchedulerState>>(schedulerStatePath(stateDir));
  return {
    jobs: state?.jobs && typeof state.jobs === "object" ? state.jobs : {},
    alerts: state?.alerts && typeof state.alerts === "object" ? state.alerts : {},
  };
}

/** Secrets redacted before the text is cut, so a truncated token can't slip past the patterns. */
export function alertErrorText(text: string, max = ALERT_ERROR_MAX): string {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function jobAlertText(a: JobAlert): string {
  if (a.kind === "recovered") return `✅ scheduled job \`${a.job}\` is working again (${a.trigger} run succeeded).`;
  if (a.kind === "stuck") {
    return `⚠️ scheduled job \`${a.job}\` (${a.trigger}) has been running since ${a.startedAt.toISOString()} and looks stuck; it was left running. Schedule: ${a.schedule}.`;
  }
  return `⚠️ scheduled job \`${a.job}\` failed (${a.trigger})${a.error ? `: ${a.error}` : ""}. It will retry on its schedule (${a.schedule}).`;
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

export function isValidJobName(name: string): boolean {
  return JOB_NAME.test(name);
}

/** `daily HH:MM`, or `every N` with a unit of m/min/minutes or h/hours; null when invalid or out of range. */
export function parseWhen(raw: string): JobWhen | null {
  const text = raw.trim().toLowerCase();
  const daily = /^daily\s+(\S+)$/.exec(text);
  if (daily) return isValidAt(daily[1]!) ? { kind: "daily", at: daily[1]! } : null;
  const every = /^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(text);
  if (!every) return null;
  const minutes = Number(every[1]) * (every[2]!.startsWith("h") ? 60 : 1);
  return minutes >= MIN_EVERY_MINUTES && minutes <= MAX_EVERY_MINUTES ? { kind: "every", minutes } : null;
}

/** `HH:MM-HH:MM`; null when invalid or empty (start equal to end). */
export function parseActiveHours(raw: string): ActiveHours | null {
  const match = /^\s*(\S+)\s*-\s*(\S+)\s*$/.exec(raw);
  if (!match || !isValidAt(match[1]!) || !isValidAt(match[2]!) || match[1] === match[2]) return null;
  return { start: match[1]!, end: match[2]! };
}

export function formatSchedule(schedule: JobSchedule | undefined, fallbackAt: string): string {
  if (!schedule) return `daily ${fallbackAt}`;
  const when = schedule.when.kind === "daily" ? `daily ${schedule.when.at}` : `every ${schedule.when.minutes}m`;
  const active = schedule.active ? `, active ${schedule.active.start}-${schedule.active.end}` : "";
  return `${when}${active}${schedule.disabled ? " (disabled)" : ""}`;
}

const minuteOfDay = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));

/** Whether `now` falls inside `active` on the wall clock of `tz` (start inclusive, end exclusive). */
export function inActiveHours(now: Date, active: ActiveHours | undefined, tz: string): boolean {
  if (!active) return true;
  const w = wallTime(now, tz);
  const m = w.h * 60 + w.mi;
  const start = minuteOfDay(active.start);
  const end = minuteOfDay(active.end);
  return start < end ? m >= start && m < end : m >= start || m < end;
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
 * Minimal in-process scheduler. A job without its own schedule runs at `at` local time, and once on startup
 * when its last run is over 24 h old (or never happened). A job with one runs on it (`every` or `daily`, within
 * its active hours; a daily run missed by over DAILY_GRACE_MS is skipped). Any job runs on demand via a request
 * file. One run per job at a time.
 */
export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly sources: Array<() => ScheduledJob[]> = [];
  private indexSignature = "";
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

  /** Adds jobs that can change between polls (e.g. from schedule.md); a name already registered wins. */
  addSource(source: () => ScheduledJob[]): void {
    this.sources.push(source);
  }

  /** Registered jobs, then valid source jobs whose names aren't taken. */
  currentJobs(): Map<string, ScheduledJob> {
    const all = new Map(this.jobs);
    for (const source of this.sources) {
      let jobs: ScheduledJob[];
      try {
        jobs = source();
      } catch (err) {
        this.opts.log?.warn({ err }, "a scheduled job source failed; skipping it this poll");
        continue;
      }
      for (const job of jobs) {
        if (JOB_NAME.test(job.name) && !all.has(job.name)) all.set(job.name, job);
      }
    }
    return all;
  }

  /** Starts polling and any startup catch-up; resolves when the catch-up runs finish. */
  start(): Promise<void> {
    if (this.timer || this.stopped) return Promise.resolve();
    const now = this.now();
    this.lastCheck = now;
    const state = readSchedulerState(this.opts.stateDir);
    const runs: Promise<unknown>[] = [];
    this.writeIndex(this.currentJobs());
    for (const [name, job] of this.jobs) {
      if (job.schedule) continue;
      const last = state.jobs[name]?.lastRunAt;
      if (!last || now.getTime() - Date.parse(last) > DAY_MS) runs.push(this.runJob(name, { trigger: "catchup", force: false }));
    }
    this.timer = setInterval(() => void this.tick().catch((err) => this.opts.log?.error({ err }, "scheduler tick failed")), this.opts.pollMs ?? 30_000);
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
    const jobs = this.currentJobs();
    this.writeIndex(jobs);

    for (const name of this.takeRequests(jobs)) runs.push(this.runJob(name, { trigger: "manual", force: true }));

    const state = readSchedulerState(this.opts.stateDir);
    const due = lastOccurrence(now, this.opts.at, this.opts.tz);
    for (const [name, job] of jobs) {
      const last = state.jobs[name]?.lastRunAt;
      if (!job.schedule) {
        if (due > since && (!last || Date.parse(last) < due.getTime())) runs.push(this.runJob(name, { trigger: "daily", force: false }));
        continue;
      }
      if (this.inFlight.has(name)) continue;
      const trigger = scheduledTrigger(job.schedule, last ? Date.parse(last) : null, now, this.opts.tz);
      if (trigger) runs.push(this.runJob(name, { trigger, force: false }));
    }
    await Promise.all(runs);
  }

  /** Runs `name` now, or joins the run already in flight. Null when the job threw. */
  runJob(name: string, ctx: JobContext): Promise<JobOutcome | null> {
    const existing = this.inFlight.get(name);
    if (existing) return existing;
    const job = this.jobs.get(name) ?? this.currentJobs().get(name);
    if (!job) return Promise.reject(new Error(`unknown job: ${name}`));
    const started = this.now();
    const schedule = formatSchedule(job.schedule, this.opts.at);
    const watchdog = setTimeout(() => {
      if (!this.stopped) this.raise(name, { job: name, kind: "stuck", trigger: ctx.trigger, startedAt: started, schedule });
    }, job.maxRunMs ?? DEFAULT_MAX_RUN_MS);
    watchdog.unref?.();
    const run = (async () => {
      let outcome: JobOutcome | null = null;
      let error: string | undefined;
      try {
        outcome = await job.run(ctx);
        this.opts.log?.info({ job: name, trigger: ctx.trigger, status: outcome.status }, "scheduled job finished");
      } catch (err) {
        this.opts.log?.error({ err, job: name, trigger: ctx.trigger }, "scheduled job failed");
        error = err instanceof Error ? err.message : String(err);
      }
      clearTimeout(watchdog);
      // Recorded after a failure too, so a job that throws retries tomorrow rather than on every restart.
      this.record(name, {
        lastRunAt: started.toISOString(),
        lastTrigger: ctx.trigger,
        lastStatus: outcome?.status ?? "error",
        ...(outcome?.summary ? { lastSummary: outcome.summary } : {}),
      });
      const status = outcome?.status ?? "error";
      const base = { job: name, trigger: ctx.trigger, startedAt: started, schedule };
      if (FAILED_STATUSES.includes(status)) {
        const text = error ?? outcome?.summary ?? status;
        this.raise(name, { ...base, kind: "failed", error: alertErrorText(text) });
      } else if (!NEUTRAL_STATUSES.includes(status)) {
        this.clearStreak(name, base);
      }
      return outcome;
    })().finally(() => {
      clearTimeout(watchdog);
      this.inFlight.delete(name);
    });
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

  private takeRequests(jobs: Map<string, ScheduledJob>): string[] {
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
      if (jobs.has(name)) taken.push(name);
      else this.opts.log?.warn({ job: name }, "manual run requested for an unknown job");
    }
    return taken;
  }

  private writeIndex(jobs: Map<string, ScheduledJob>): void {
    const entries: JobIndexEntry[] = [...jobs.values()].map((j) => ({ name: j.name, schedule: formatSchedule(j.schedule, this.opts.at) }));
    const signature = JSON.stringify(entries);
    if (signature === this.indexSignature) return;
    try {
      mkdirSync(this.opts.stateDir, { recursive: true });
      writeFileAtomic(jobIndexPath(this.opts.stateDir), `${JSON.stringify({ tz: this.opts.tz, jobs: entries }, null, 2)}\n`);
      this.indexSignature = signature;
    } catch (err) {
      this.opts.log?.warn({ err }, "failed to write the scheduled job index");
    }
  }

  /** Sends `alert` unless this job's current failure streak was already reported. */
  private raise(name: string, alert: JobAlert & { kind: "failed" | "stuck" }): void {
    const state = readSchedulerState(this.opts.stateDir);
    if (state.alerts[name]) return;
    state.alerts[name] = { at: this.now().toISOString(), kind: alert.kind };
    if (!this.writeState(state, name)) return;
    this.emit(alert);
  }

  private clearStreak(name: string, base: Omit<JobAlert, "kind">): void {
    const state = readSchedulerState(this.opts.stateDir);
    if (!state.alerts[name]) return;
    delete state.alerts[name];
    if (this.writeState(state, name)) this.emit({ ...base, kind: "recovered" });
  }

  private emit(alert: JobAlert): void {
    const hook = this.opts.onJobAlert;
    if (!hook) return;
    try {
      void Promise.resolve(hook(alert)).catch((err) => this.opts.log?.warn({ err, job: alert.job }, "failed to send a scheduled job alert"));
    } catch (err) {
      this.opts.log?.warn({ err, job: alert.job }, "failed to send a scheduled job alert");
    }
  }

  private writeState(state: SchedulerState, name: string): boolean {
    try {
      mkdirSync(this.opts.stateDir, { recursive: true });
      writeFileAtomic(schedulerStatePath(this.opts.stateDir), `${JSON.stringify(state, null, 2)}\n`);
      return true;
    } catch (err) {
      this.opts.log?.error({ err, job: name }, "failed to write the scheduler state");
      return false;
    }
  }

  private record(name: string, run: JobRunState): void {
    const state = readSchedulerState(this.opts.stateDir);
    state.jobs[name] = run;
    this.writeState(state, name);
  }
}

/** Whether a job with its own schedule is due at `now`, given when it last ran (ms, or null). */
export function scheduledTrigger(schedule: JobSchedule, lastRunMs: number | null, now: Date, tz: string): JobTrigger | null {
  if (schedule.disabled || !inActiveHours(now, schedule.active, tz)) return null;
  if (schedule.when.kind === "every") {
    return lastRunMs === null || now.getTime() - lastRunMs >= schedule.when.minutes * 60_000 ? "interval" : null;
  }
  const occurrence = lastOccurrence(now, schedule.when.at, tz).getTime();
  if (now.getTime() - occurrence > DAILY_GRACE_MS) return null;
  return lastRunMs === null || lastRunMs < occurrence ? "daily" : null;
}
