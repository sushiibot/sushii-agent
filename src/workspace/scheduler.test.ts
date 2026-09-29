import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, lastOccurrence, readSchedulerState, requestPath, requestRun, schedulerStatePath, type JobContext, type JobOutcome } from "./scheduler.ts";
import { runWsConsolidate } from "./wsConsolidate.ts";

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
    expect(readSchedulerState(stateDir).jobs.consolidation!.lastStatus).toBe("error");
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
