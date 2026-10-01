import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALERT_ERROR_MAX,
  DAILY_GRACE_MS,
  DEFAULT_MAX_RUN_MS,
  MAX_TIMER_MS,
  Scheduler,
  alertErrorText,
  effectiveMaxRunMs,
  outcomeKind,
  jobAlertText,
  inActiveHours,
  jobAlertWire,
  lastOccurrence,
  parseActiveHours,
  parseWhen,
  readJobIndex,
  readSchedulerState,
  requestPath,
  requestRun,
  scheduledTrigger,
  schedulerStatePath,
  type JobAlert,
  type JobContext,
  type JobOutcome,
  type JobSchedule,
  withRunId,
} from "./scheduler.ts";
import { chatDeliverParams } from "../orchestration/contracts.ts";
import { runWsConsolidate } from "./wsConsolidate.ts";
import { runWsSchedule } from "./wsSchedule.ts";

let stateDir: string;
let clock: Date;
let schedulers: Scheduler[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ws-sched-"));
  clock = new Date("2026-09-29T12:00:00Z");
  schedulers = [];
});

afterEach(async () => {
  for (const s of schedulers) await s.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

function scheduler(opts: { at?: string; tz?: string } = {}): Scheduler {
  const s = new Scheduler({ stateDir, at: opts.at ?? "04:00", tz: opts.tz ?? "UTC", now: () => clock, pollMs: 60_000 });
  schedulers.push(s);
  return s;
}

function recordingJob(name = "consolidation", impl?: (ctx: JobContext) => Promise<JobOutcome>) {
  const calls: JobContext[] = [];
  return {
    calls,
    job: {
      name,
      run: async (ctx: JobContext) => {
        calls.push(ctx);
        return impl ? impl(ctx) : { status: "applied", summary: "ok" };
      },
    },
  };
}

function seedLastRun(name: string, at: string): void {
  writeFileSync(schedulerStatePath(stateDir), JSON.stringify({ jobs: { [name]: { lastRunAt: at, lastTrigger: "daily", lastStatus: "applied" } } }));
}

describe("lastOccurrence", () => {
  test("today's time once it has passed, else yesterday's", () => {
    expect(lastOccurrence(new Date("2026-09-29T12:00:00Z"), "04:00", "UTC").toISOString()).toBe("2026-09-29T04:00:00.000Z");
    expect(lastOccurrence(new Date("2026-09-29T03:59:00Z"), "04:00", "UTC").toISOString()).toBe("2026-09-28T04:00:00.000Z");
    expect(lastOccurrence(new Date("2026-09-29T04:00:00Z"), "04:00", "UTC").toISOString()).toBe("2026-09-29T04:00:00.000Z");
  });

  test("honours the configured zone, across a DST change", () => {
    // 04:00 in New York is 08:00Z under EDT and 09:00Z under EST.
    expect(lastOccurrence(new Date("2026-09-29T12:00:00Z"), "04:00", "America/New_York").toISOString()).toBe("2026-09-29T08:00:00.000Z");
    expect(lastOccurrence(new Date("2026-12-01T12:00:00Z"), "04:00", "America/New_York").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(lastOccurrence(new Date("2026-12-01T08:30:00Z"), "04:00", "America/New_York").toISOString()).toBe("2026-11-30T09:00:00.000Z");
  });

  test("rejects a bad zone or time", () => {
    expect(() => new Scheduler({ stateDir, at: "04:00", tz: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => new Scheduler({ stateDir, at: "4am", tz: "UTC" })).toThrow(/time of day/);
  });
});

describe("Scheduler", () => {
  test("startup catch-up runs a job that never ran, and records it", async () => {
    const s = scheduler();
    const { job, calls } = recordingJob();
    s.register(job);
    await s.start();
    expect(calls).toEqual([{ trigger: "catchup", force: false }]);
    const state = readSchedulerState(stateDir).jobs.consolidation!;
    expect(state).toMatchObject({ lastRunAt: clock.toISOString(), lastTrigger: "catchup", lastStatus: "applied", lastSummary: "ok" });
  });

  test("startup catch-up runs only when the last run is over 24 h old", async () => {
    seedLastRun("consolidation", "2026-09-28T13:00:00Z");
    const recent = recordingJob();
    const s1 = scheduler();
    s1.register(recent.job);
    await s1.start();
    expect(recent.calls).toEqual([]);
    await s1.stop();

    seedLastRun("consolidation", "2026-09-28T11:00:00Z");
    const stale = recordingJob();
    const s2 = scheduler();
    s2.register(stale.job);
    await s2.start();
    expect(stale.calls.map((c) => c.trigger)).toEqual(["catchup"]);
  });

  test("daily trigger fires once when the configured time passes", async () => {
    clock = new Date("2026-09-29T03:58:00Z");
    seedLastRun("consolidation", "2026-09-28T04:00:00Z");
    const s = scheduler();
    const { job, calls } = recordingJob();
    s.register(job);
    await s.start();
    await s.tick();
    expect(calls).toEqual([]);

    clock = new Date("2026-09-29T04:00:30Z");
    await s.tick();
    expect(calls).toEqual([{ trigger: "daily", force: false }]);

    clock = new Date("2026-09-29T04:01:00Z");
    await s.tick();
    clock = new Date("2026-09-29T20:00:00Z");
    await s.tick();
    expect(calls).toHaveLength(1);

    clock = new Date("2026-09-30T04:00:10Z");
    await s.tick();
    expect(calls).toHaveLength(2);
    expect(readSchedulerState(stateDir).jobs.consolidation!.lastRunAt).toBe("2026-09-30T04:00:10.000Z");
  });

  test("a job that throws is recorded as an error and isn't retried on restart", async () => {
    const s = scheduler();
    s.register({ name: "consolidation", run: async () => Promise.reject(new Error("model down")) });
    await s.start();
    expect(readSchedulerState(stateDir).jobs.consolidation).toMatchObject({ lastStatus: "error", lastSummary: "model down" });
    await s.stop();

    const again = recordingJob();
    const s2 = scheduler();
    s2.register(again.job);
    await s2.start();
    expect(again.calls).toEqual([]);
  });

  test("single-flight: a second run of the same job joins the one in flight", async () => {
    seedLastRun("consolidation", clock.toISOString());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { job, calls } = recordingJob("consolidation", async () => {
      await gate;
      return { status: "applied" };
    });
    const s = scheduler();
    s.register(job);
    await s.start();
    const a = s.runJob("consolidation", { trigger: "manual", force: true });
    const b = s.runJob("consolidation", { trigger: "daily", force: false });
    requestRun(stateDir, "consolidation");
    const c = s.tick();
    release();
    await Promise.all([a, b, c]);
    expect(calls).toHaveLength(1);
    expect(await a).toEqual({ status: "applied" });

    // Once it's done, the next run starts fresh.
    await s.runJob("consolidation", { trigger: "manual", force: true });
    expect(calls).toHaveLength(2);
  });

  test("a manual request is claimed once and runs forced", async () => {
    seedLastRun("consolidation", clock.toISOString());
    const s = scheduler();
    const { job, calls } = recordingJob();
    s.register(job);
    await s.start();
    requestRun(stateDir, "consolidation");
    requestRun(stateDir, "unknown-job");
    await s.tick();
    await s.tick();
    expect(calls).toEqual([{ trigger: "manual", force: true }]);
    expect(existsSync(requestPath(stateDir, "consolidation"))).toBe(false);
    expect(existsSync(requestPath(stateDir, "unknown-job"))).toBe(false);
  });

  test("stop() halts polling and waits for the run in flight", async () => {
    seedLastRun("consolidation", clock.toISOString());
    let finished = false;
    const s = scheduler();
    s.register({
      name: "consolidation",
      run: async () => {
        await new Promise((r) => setTimeout(r, 30));
        finished = true;
        return { status: "applied" };
      },
    });
    await s.start();
    void s.runJob("consolidation", { trigger: "manual", force: true });
    await s.stop();
    expect(finished).toBe(true);
    requestRun(stateDir, "consolidation");
    await s.tick();
    expect(existsSync(requestPath(stateDir, "consolidation"))).toBe(true);
  });
});

describe("ws-consolidate", () => {
  function cli(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runWsConsolidate(argv, { env: { WORKSPACE_STATE_DIR: stateDir }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => clock });
    return { code, out, err };
  }

  test("--now queues a forced run that the scheduler picks up; --status reports it", async () => {
    expect(cli(["--status"]).out).toEqual(["no consolidation has run yet"]);
    seedLastRun("consolidation", "2026-09-29T04:00:00Z");
    const s = scheduler();
    const { job, calls } = recordingJob("consolidation", async () => ({ status: "rejected", summary: "rejected: MEMORY.md over cap" }));
    s.register(job);
    await s.start();

    const queued = cli(["--now"]);
    expect(queued.code).toBe(0);
    expect(queued.out[0]).toContain("queued");
    expect(existsSync(requestPath(stateDir, "consolidation"))).toBe(true);

    await s.tick();
    expect(calls).toEqual([{ trigger: "manual", force: true }]);
    const status = cli(["--status"]);
    expect(status.out).toEqual([`last run: ${clock.toISOString()} (manual) → rejected`, "rejected: MEMORY.md over cap"]);
  });

  test("usage on bad arguments", () => {
    expect(cli([]).code).toBe(2);
    expect(cli(["--now", "--status"]).code).toBe(2);
    expect(cli(["--later"]).err[0]).toContain("usage");
  });
});

describe("per-job schedules", () => {
  const every = (minutes: number, active?: string): JobSchedule => ({
    when: { kind: "every", minutes },
    ...(active ? { active: parseActiveHours(active)! } : {}),
  });

  test("parseWhen and parseActiveHours accept the documented forms only", () => {
    expect(parseWhen("daily 08:00")).toEqual({ kind: "daily", at: "08:00" });
    expect(parseWhen("every 120m")).toEqual({ kind: "every", minutes: 120 });
    expect(parseWhen("Every 90 minutes")).toEqual({ kind: "every", minutes: 90 });
    expect(parseWhen("every 2h")).toEqual({ kind: "every", minutes: 120 });
    for (const bad of ["daily 8am", "daily 24:00", "every 4m", "every 25h", "every", "hourly", "every 10 seconds"]) expect(parseWhen(bad)).toBeNull();
    expect(parseActiveHours("08:00-22:00")).toEqual({ start: "08:00", end: "22:00" });
    expect(parseActiveHours("22:00 - 06:00")).toEqual({ start: "22:00", end: "06:00" });
    for (const bad of ["08:00", "8-22", "08:00-08:00", "08:00-25:00"]) expect(parseActiveHours(bad)).toBeNull();
  });

  test("active hours use the zone's wall clock, wrap midnight, and follow DST", () => {
    const day = { start: "08:00", end: "22:00" };
    expect(inActiveHours(new Date("2026-09-29T07:59:00Z"), day, "UTC")).toBe(false);
    expect(inActiveHours(new Date("2026-09-29T08:00:00Z"), day, "UTC")).toBe(true);
    expect(inActiveHours(new Date("2026-09-29T22:00:00Z"), day, "UTC")).toBe(false);
    const night = { start: "22:00", end: "06:00" };
    expect(inActiveHours(new Date("2026-09-29T23:30:00Z"), night, "UTC")).toBe(true);
    expect(inActiveHours(new Date("2026-09-29T05:59:00Z"), night, "UTC")).toBe(true);
    expect(inActiveHours(new Date("2026-09-29T12:00:00Z"), night, "UTC")).toBe(false);
    // New York: 08:00 local is 12:00Z in EDT (Oct 31), 13:00Z in EST after the Nov 1 fall-back.
    const ny = "America/New_York";
    expect(inActiveHours(new Date("2026-10-31T12:00:00Z"), day, ny)).toBe(true);
    expect(inActiveHours(new Date("2026-11-02T12:00:00Z"), day, ny)).toBe(false);
    expect(inActiveHours(new Date("2026-11-02T13:00:00Z"), day, ny)).toBe(true);
  });

  test("every N minutes: first poll, then only once N minutes have passed", () => {
    const s = every(120);
    const now = new Date("2026-09-29T12:00:00Z");
    expect(scheduledTrigger(s, null, now, "UTC")).toBe("interval");
    expect(scheduledTrigger(s, now.getTime() - 119 * 60_000, now, "UTC")).toBeNull();
    expect(scheduledTrigger(s, now.getTime() - 120 * 60_000, now, "UTC")).toBe("interval");
    expect(scheduledTrigger(every(120, "13:00-22:00"), null, now, "UTC")).toBeNull();
    expect(scheduledTrigger({ ...s, disabled: true }, null, now, "UTC")).toBeNull();
  });

  test("daily at a time: once per occurrence, within the grace window, across a DST gap", () => {
    const s: JobSchedule = { when: { kind: "daily", at: "08:00" } };
    expect(scheduledTrigger(s, null, new Date("2026-09-29T07:59:00Z"), "UTC")).toBeNull();
    expect(scheduledTrigger(s, null, new Date("2026-09-29T08:00:30Z"), "UTC")).toBe("daily");
    expect(scheduledTrigger(s, Date.parse("2026-09-29T08:00:30Z"), new Date("2026-09-29T08:30:00Z"), "UTC")).toBeNull();
    // A restart that missed the time by over an hour skips it rather than sending late.
    const late = new Date(Date.parse("2026-09-29T08:00:00Z") + DAILY_GRACE_MS + 60_000);
    expect(scheduledTrigger(s, Date.parse("2026-09-28T08:00:00Z"), late, "UTC")).toBeNull();
    // 02:30 doesn't exist in New York on 2027-03-14; lastOccurrence places it at 06:30Z and it still fires once.
    const gap: JobSchedule = { when: { kind: "daily", at: "02:30" } };
    const ny = "America/New_York";
    expect(scheduledTrigger(gap, Date.parse("2027-03-13T07:30:00Z"), new Date("2027-03-14T06:29:00Z"), ny)).toBeNull();
    expect(scheduledTrigger(gap, Date.parse("2027-03-13T07:30:00Z"), new Date("2027-03-14T06:30:00Z"), ny)).toBe("daily");
    expect(scheduledTrigger(gap, Date.parse("2027-03-14T06:30:00Z"), new Date("2027-03-14T07:10:00Z"), ny)).toBeNull();
    // The day after, 02:30 EDT is 06:30Z again.
    expect(scheduledTrigger(gap, Date.parse("2027-03-14T06:30:00Z"), new Date("2027-03-15T06:30:00Z"), ny)).toBe("daily");
  });

  test("the scheduler runs per-job schedules on its polls and keeps the default daily job on `at`", async () => {
    seedLastRun("consolidation", clock.toISOString());
    const s = scheduler();
    const consolidation = recordingJob();
    const beat = recordingJob("heartbeat");
    s.register(consolidation.job);
    s.register({ ...beat.job, schedule: every(60, "08:00-22:00") });
    await s.start();
    // Startup catch-up is only for jobs without their own schedule.
    expect(beat.calls).toEqual([]);
    await s.tick();
    expect(beat.calls).toEqual([{ trigger: "interval", force: false }]);
    clock = new Date("2026-09-29T12:59:00Z");
    await s.tick();
    expect(beat.calls).toHaveLength(1);
    clock = new Date("2026-09-29T13:00:00Z");
    await s.tick();
    expect(beat.calls).toHaveLength(2);
    clock = new Date("2026-09-29T23:00:00Z");
    await s.tick();
    expect(beat.calls).toHaveLength(2);
    expect(consolidation.calls).toEqual([]);
    clock = new Date("2026-09-30T04:00:10Z");
    await s.tick();
    expect(consolidation.calls).toEqual([{ trigger: "daily", force: false }]);
    expect(beat.calls).toHaveLength(2);
  });

  test("source jobs: picked up and dropped between polls, registered names win, manual runs reach them, the index follows", async () => {
    seedLastRun("consolidation", clock.toISOString());
    const s = scheduler();
    s.register(recordingJob().job);
    const brief = recordingJob("brief");
    const shadow = recordingJob("consolidation");
    let source = [{ ...brief.job, schedule: { when: { kind: "daily", at: "12:00" }, disabled: true } as JobSchedule }, shadow.job];
    s.addSource(() => source);
    await s.start();
    expect(readJobIndex(stateDir)).toEqual([
      { name: "consolidation", schedule: "daily 04:00" },
      { name: "brief", schedule: "daily 12:00 (disabled)" },
    ]);
    await s.tick();
    expect(brief.calls).toEqual([]);

    requestRun(stateDir, "brief");
    await s.tick();
    expect(brief.calls).toEqual([{ trigger: "manual", force: true }]);

    source = [];
    await s.tick();
    expect(readJobIndex(stateDir)).toEqual([{ name: "consolidation", schedule: "daily 04:00" }]);
    requestRun(stateDir, "brief");
    await s.tick();
    expect(brief.calls).toHaveLength(1);
    expect(shadow.calls).toEqual([]);
  });

  test("a source that throws is skipped for that poll", async () => {
    const s = scheduler();
    s.addSource(() => {
      throw new Error("bad file");
    });
    await s.start();
    await s.tick();
    expect(readJobIndex(stateDir)).toEqual([]);
  });
});

describe("ws-schedule", () => {
  function cli(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runWsSchedule(argv, { env: { WORKSPACE_STATE_DIR: stateDir }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => clock });
    return { code, out, err };
  }

  test("list shows the jobs and their last runs; run queues a manual run the scheduler picks up", async () => {
    expect(cli(["list"]).out[0]).toContain("hasn't started");
    seedLastRun("consolidation", clock.toISOString());
    const s = scheduler();
    s.register(recordingJob().job);
    const beat = recordingJob("heartbeat", async () => ({ status: "no_reply" }));
    s.register({ ...beat.job, schedule: { when: { kind: "every", minutes: 120 }, active: { start: "08:00", end: "22:00" } } });
    await s.start();
    expect(cli(["list"]).out).toEqual([
      `consolidation: daily 04:00; last ${clock.toISOString()} (daily) → applied`,
      "heartbeat: every 120m, active 08:00-22:00; never run",
    ]);

    const queued = cli(["run", "heartbeat"]);
    expect(queued.code).toBe(0);
    expect(existsSync(requestPath(stateDir, "heartbeat"))).toBe(true);
    await s.tick();
    expect(beat.calls[0]).toEqual({ trigger: "manual", force: true });
    expect(cli(["list"]).out[1]).toBe(`heartbeat: every 120m, active 08:00-22:00; last ${clock.toISOString()} (manual) → no_reply`);
  });

  test("errors: unknown or invalid job, bad usage", async () => {
    const s = scheduler();
    s.register(recordingJob().job);
    await s.start();
    expect(cli(["run", "nope"])).toMatchObject({ code: 1, err: ["ws-schedule: unknown job: nope (see ws-schedule list; a new schedule.md job loads within a minute)"] });
    expect(cli(["run", "../x"]).code).toBe(1);
    expect(cli([]).code).toBe(2);
    expect(cli(["run"]).code).toBe(2);
    expect(cli(["list", "x"]).code).toBe(2);
  });
});

describe("job alerts", () => {
  function alerting(): { s: Scheduler; alerts: JobAlert[] } {
    const alerts: JobAlert[] = [];
    const s = new Scheduler({ stateDir, at: "04:00", tz: "UTC", now: () => clock, pollMs: 60_000, onJobAlert: (a) => void alerts.push(a) });
    schedulers.push(s);
    return { s, alerts };
  }

  test("a throw alerts once per failure streak, and a success ends it with one recovered note", async () => {
    const { s, alerts } = alerting();
    let fail = true;
    s.register({ name: "consolidation", run: async () => (fail ? Promise.reject(new Error("model down")) : { status: "applied" }) });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ job: "consolidation", kind: "failed", trigger: "daily", error: "model down", schedule: "daily 04:00" });
    expect(readSchedulerState(stateDir).alerts.consolidation).toMatchObject({ kind: "failed" });

    fail = false;
    await s.runJob("consolidation", { trigger: "manual", force: true });
    await s.runJob("consolidation", { trigger: "manual", force: true });
    expect(alerts.map((a) => a.kind)).toEqual(["failed", "recovered"]);
    expect(readSchedulerState(stateDir).alerts.consolidation).toBeUndefined();

    fail = true;
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts.map((a) => a.kind)).toEqual(["failed", "recovered", "failed"]);
  });

  test("an alert names the run that failed, and recovered the run that succeeded", async () => {
    const { s, alerts } = alerting();
    const failedRun = "01J0000000000000000000000A";
    const okRun = "01J0000000000000000000000B";
    let fail = true;
    s.register({ name: "nightly", run: async () => (fail ? Promise.reject(withRunId(new Error("model down"), failedRun)) : { status: "sent", runId: okRun }) });
    await s.runJob("nightly", { trigger: "daily", force: false });
    fail = false;
    await s.runJob("nightly", { trigger: "manual", force: true });
    expect(alerts.map((a) => [a.kind, a.runId])).toEqual([["failed", failedRun], ["recovered", okRun]]);
  });

  test("jobAlertWire is what chat/deliver accepts, and drops a runId that isn't one", () => {
    const a: JobAlert = { job: "nightly", kind: "failed", trigger: "daily", startedAt: new Date("2026-09-30T04:00:00Z"), error: "boom", schedule: "daily 04:00", runId: "not-a-run" };
    const wire = jobAlertWire(a);
    expect(wire).toEqual({ source: "job", job: "nightly", kind: "failed", trigger: "daily", startedAt: "2026-09-30T04:00:00.000Z", error: "boom", schedule: "daily 04:00" });
    expect(chatDeliverParams.safeParse({ outboxId: "o", principalId: "p", kind: "alert", text: jobAlertText(a), alert: wire }).success).toBe(true);
  });

  test("the streak survives a restart, so a new process doesn't alert again", async () => {
    const first = alerting();
    first.s.register({ name: "consolidation", run: async () => Promise.reject(new Error("model down")) });
    await first.s.runJob("consolidation", { trigger: "daily", force: false });
    await first.s.stop();

    const second = alerting();
    second.s.register({ name: "consolidation", run: async () => Promise.reject(new Error("model down")) });
    await second.s.runJob("consolidation", { trigger: "daily", force: false });
    expect(first.alerts).toHaveLength(1);
    expect(second.alerts).toEqual([]);
  });

  test("a failed outcome status alerts with its summary; skipped neither alerts nor clears the streak", async () => {
    const { s, alerts } = alerting();
    let outcome: JobOutcome = { status: "rejected", summary: "rejected: dropped a fact" };
    s.register({ name: "consolidation", run: async () => outcome });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts).toEqual([expect.objectContaining({ kind: "failed", error: "rejected: dropped a fact" })]);

    outcome = { status: "skipped", summary: "skipped: same inputs" };
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts).toHaveLength(1);
    expect(readSchedulerState(stateDir).alerts.consolidation).toBeDefined();

    outcome = { status: "applied" };
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts.map((a) => a.kind)).toEqual(["failed", "recovered"]);
  });

  test("a run past its max runtime is reported stuck once, left running, then reported once more when it fails", async () => {
    const { s, alerts } = alerting();
    let finish!: (o: JobOutcome) => void;
    let fail!: (e: Error) => void;
    s.register({ name: "slow", maxRunMs: 20, run: () => new Promise<JobOutcome>((resolve, reject) => ((finish = resolve), (fail = reject))) });
    const run = s.runJob("slow", { trigger: "manual", force: true });
    await Bun.sleep(80);
    expect(alerts).toEqual([expect.objectContaining({ job: "slow", kind: "stuck", trigger: "manual" })]);
    fail(new Error("gave up"));
    await run;
    expect(alerts.map((a) => a.kind)).toEqual(["stuck", "failed"]);
    expect(alerts[1]!.error).toBe("gave up");
    expect(readSchedulerState(stateDir).alerts.slow).toMatchObject({ kind: "failed" });

    const failing = s.runJob("slow", { trigger: "manual", force: true });
    fail(new Error("gave up again"));
    await failing;
    expect(alerts).toHaveLength(2);

    const again = s.runJob("slow", { trigger: "manual", force: true });
    finish({ status: "sent" });
    await again;
    expect(alerts.map((a) => a.kind)).toEqual(["stuck", "failed", "recovered"]);
  });

  test("a stuck run that then succeeds sends only the recovered note", async () => {
    const { s, alerts } = alerting();
    let finish!: (o: JobOutcome) => void;
    s.register({ name: "slow", maxRunMs: 20, run: () => new Promise<JobOutcome>((resolve) => (finish = resolve)) });
    const run = s.runJob("slow", { trigger: "manual", force: true });
    await Bun.sleep(80);
    finish({ status: "sent" });
    await run;
    expect(alerts.map((a) => a.kind)).toEqual(["stuck", "recovered"]);
  });

  test("an invalid max runtime falls back to the default instead of firing at once", async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_MS + 1]) expect(effectiveMaxRunMs(bad)).toBe(DEFAULT_MAX_RUN_MS);
    expect(effectiveMaxRunMs(undefined)).toBe(DEFAULT_MAX_RUN_MS);
    expect(effectiveMaxRunMs(MAX_TIMER_MS)).toBe(MAX_TIMER_MS);
    expect(effectiveMaxRunMs(20)).toBe(20);

    const { s, alerts } = alerting();
    let finish!: (o: JobOutcome) => void;
    s.register({ name: "slow", maxRunMs: 0, run: () => new Promise<JobOutcome>((resolve) => (finish = resolve)) });
    const run = s.runJob("slow", { trigger: "manual", force: true });
    await Bun.sleep(40);
    expect(alerts).toEqual([]);
    finish({ status: "sent" });
    await run;
  });

  test("only known success statuses end a streak; an unknown one is neutral unless it reads like a failure", async () => {
    expect(outcomeKind("applied")).toBe("success");
    expect(outcomeKind("skipped")).toBe("neutral");
    expect(outcomeKind("deferred")).toBe("neutral");
    expect(outcomeKind("timed_out")).toBe("failure");
    expect(outcomeKind("partial_failure")).toBe("failure");

    const { s, alerts } = alerting();
    let outcome: JobOutcome = { status: "error" };
    s.register({ name: "consolidation", run: async () => outcome });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    outcome = { status: "deferred" };
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts.map((a) => a.kind)).toEqual(["failed"]);
    expect(readSchedulerState(stateDir).alerts.consolidation).toBeDefined();

    outcome = { status: "sent" };
    await s.runJob("consolidation", { trigger: "daily", force: false });
    outcome = { status: "upload_failed", summary: "upload failed: 503" };
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts.map((a) => a.kind)).toEqual(["failed", "recovered", "failed"]);
    expect(alerts[2]!.error).toBe("upload failed: 503");
  });

  test("a failed state write still sends the alert, deduped in memory", async () => {
    mkdirSync(schedulerStatePath(stateDir), { recursive: true });
    const { s, alerts } = alerting();
    let fail = true;
    s.register({ name: "consolidation", run: async () => (fail ? Promise.reject(new Error("disk full")) : { status: "applied" }) });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts.map((a) => a.kind)).toEqual(["failed"]);

    fail = false;
    await s.runJob("consolidation", { trigger: "daily", force: false });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    fail = true;
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts.map((a) => a.kind)).toEqual(["failed", "recovered", "failed"]);
  });

  test("a run that ends after stop() is recorded but neither alerts nor opens a streak", async () => {
    const { s, alerts } = alerting();
    let fail!: (e: Error) => void;
    s.register({ name: "consolidation", run: () => new Promise<JobOutcome>((_, reject) => (fail = reject)) });
    const run = s.runJob("consolidation", { trigger: "daily", force: false });
    const stopping = s.stop(1000);
    fail(new Error("session disposed"));
    await run;
    await stopping;
    expect(alerts).toEqual([]);
    expect(readSchedulerState(stateDir).alerts.consolidation).toBeUndefined();
    expect(readSchedulerState(stateDir).jobs.consolidation!.lastStatus).toBe("error");
  });

  test("the error's cause is appended", async () => {
    const { s, alerts } = alerting();
    s.register({ name: "consolidation", run: async () => Promise.reject(new Error("fetch failed", { cause: new Error("ECONNREFUSED 10.0.0.1:443") })) });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(alerts[0]!.error).toBe("fetch failed: ECONNREFUSED 10.0.0.1:443");
  });

  test("a run that finishes within its max runtime sends nothing", async () => {
    const { s, alerts } = alerting();
    s.register({ name: "quick", maxRunMs: 30, run: async () => ({ status: "sent" }) });
    await s.runJob("quick", { trigger: "manual", force: true });
    await Bun.sleep(60);
    expect(alerts).toEqual([]);
  });

  test("the error text is redacted before it is flattened to one line and truncated", async () => {
    const { s, alerts } = alerting();
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const long = `request failed\nwith ${token}\n${"x".repeat(400)}`;
    s.register({ name: "consolidation", run: async () => Promise.reject(new Error(long)) });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    const error = alerts[0]!.error!;
    expect(error).not.toContain("ghp_");
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain("\n");
    expect(error.startsWith("request failed with [REDACTED] x")).toBe(true);
    expect(error.length).toBe(ALERT_ERROR_MAX);
    expect(error.endsWith("…")).toBe(true);
    expect(alertErrorText(`${"y".repeat(ALERT_ERROR_MAX - 20)} ${token}`)).toBe(`${"y".repeat(ALERT_ERROR_MAX - 20)} [REDACTED]`);
  });

  test("a throwing alert hook doesn't stop the run being recorded", async () => {
    const s = new Scheduler({
      stateDir,
      at: "04:00",
      tz: "UTC",
      now: () => clock,
      onJobAlert: () => {
        throw new Error("surface down");
      },
    });
    schedulers.push(s);
    s.register({ name: "consolidation", run: async () => Promise.reject(new Error("model down")) });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    expect(readSchedulerState(stateDir).jobs.consolidation!.lastStatus).toBe("error");
  });

  test("an alert hook whose promise rejects is caught, and the streak is still deduped", async () => {
    let calls = 0;
    const s = new Scheduler({
      stateDir,
      at: "04:00",
      tz: "UTC",
      now: () => clock,
      onJobAlert: async () => {
        calls++;
        await Bun.sleep(1);
        throw new Error("surface down");
      },
    });
    schedulers.push(s);
    s.register({ name: "consolidation", run: async () => Promise.reject(new Error("model down")) });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    await Bun.sleep(20);
    expect(calls).toBe(1);
    expect(readSchedulerState(stateDir).alerts.consolidation).toMatchObject({ kind: "failed" });
    await s.runJob("consolidation", { trigger: "daily", force: false });
    await Bun.sleep(20);
    expect(calls).toBe(1);
  });

  test("alert text", () => {
    const startedAt = new Date("2026-09-29T04:00:00Z");
    expect(jobAlertText({ job: "consolidation", kind: "failed", trigger: "daily", startedAt, error: "model down", schedule: "daily 04:00" })).toBe(
      "⚠️ scheduled job `consolidation` failed (daily): model down. It will retry on its schedule (daily 04:00).",
    );
    expect(jobAlertText({ job: "brief", kind: "recovered", trigger: "interval", startedAt, schedule: "every 60m" })).toContain("working again");
    expect(jobAlertText({ job: "brief", kind: "stuck", trigger: "interval", startedAt, schedule: "every 60m" }, new Date("2026-09-29T04:42:10Z"))).toBe(
      "⚠️ scheduled job `brief` (interval) has been running for 42 min and looks stuck; it was left running. It won't run again until it finishes or the workspace restarts. Schedule: every 60m.",
    );
    expect(jobAlertText({ job: "brief", kind: "failed", trigger: "manual", startedAt, error: "boom", schedule: "every 60m (disabled)", disabled: true })).toBe(
      "⚠️ scheduled job `brief` failed (manual): boom. It won't retry on its own (the job is disabled).",
    );
  });
});
