import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceConfigError, loadWorkspaceConfig, type WorkspaceConfig } from "./config.ts";
import { BackendSelector } from "./chatgptFallback.ts";
import type { ToolFreeJobInput, ToolFreeJobResult } from "./jobSession.ts";
import {
  DAILY_JOB_WINDOW_MS,
  HEARTBEAT_PROMPT,
  ProactiveLimiter,
  createHeartbeatJob,
  createPromptJob,
  isNoReply,
  recentDailyNotes,
  wireProactiveJobs,
  type PromptJobDeps,
} from "./proactive.ts";
import { RunLog } from "./runLog.ts";
import { Scheduler, readJobIndex, readSchedulerState, requestRun, type JobSchedule } from "./scheduler.ts";

let root: string;
let clock: Date;
let delivered: string[];
let notes: Array<{ name: string; text: string }>;
let runnerCalls: ToolFreeJobInput[];
let reply: string;

const HEARTBEAT: JobSchedule = { when: { kind: "every", minutes: 120 }, active: { start: "08:00", end: "22:00" } };

function config(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    home: join(root, "home"),
    stateDir: join(root, "state"),
    agentDir: join(root, "agent"),
    tz: "UTC",
    consolidateAt: "04:00",
    heartbeat: HEARTBEAT,
    proactiveDailyCap: 6,
    ...overrides,
  } as WorkspaceConfig;
}

async function fakeRunner(_config: WorkspaceConfig, input: ToolFreeJobInput): Promise<ToolFreeJobResult> {
  runnerCalls.push(input);
  return { text: reply, model: "test/model", sessionFile: "/dev/null" };
}

function deps(overrides: Partial<PromptJobDeps> = {}): PromptJobDeps {
  const cfg = overrides.config ?? config();
  return {
    config: cfg,
    runs: new RunLog(cfg.stateDir),
    selector: new BackendSelector({ primaryEnabled: false }),
    limiter: new ProactiveLimiter(cfg.stateDir, cfg.proactiveDailyCap),
    deliver: (text) => delivered.push(text),
    note: async (name, text) => {
      notes.push({ name, text });
    },
    runner: fakeRunner,
    now: () => clock,
    ...overrides,
  };
}

const scheduled = { trigger: "interval" as const, force: false };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ws-proactive-"));
  mkdirSync(join(root, "home", "memory"), { recursive: true });
  clock = new Date("2026-09-29T12:00:00Z");
  delivered = [];
  notes = [];
  runnerCalls = [];
  reply = "NO_REPLY";
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("heartbeat", () => {
  test("NO_REPLY sends nothing and notes nothing", async () => {
    for (const r of ["NO_REPLY", "  NO_REPLY\n", "`NO_REPLY`", "NO_REPLY.", "**NO_REPLY**", "\"NO_REPLY\"", "_NO_REPLY_!", "Nothing needs attention. NO_REPLY", "NO_REPLY — all clear"]) {
      reply = r;
      const outcome = await createHeartbeatJob(HEARTBEAT, deps()).run(scheduled);
      expect(outcome).toEqual({ status: "no_reply" });
    }
    expect(delivered).toEqual([]);
    expect(notes).toEqual([]);
    expect(isNoReply("The NO_REPLY sentinel showed up in the logs today.")).toBe(false);
    expect(isNoReply("NO_REPLYING is not a word")).toBe(false);
    expect(isNoReply("Your dentist appointment is at 3pm.")).toBe(false);
  });

  test("the session is light and read-only: job:heartbeat, AGENTS.md + USER.md, the prompt and the newest daily note", async () => {
    writeFileSync(join(root, "home", "memory", "2026-09-28.md"), "- old note\n");
    writeFileSync(join(root, "home", "memory", "2026-09-29.md"), `${Array.from({ length: 20 }, (_, i) => `- note ${i}`).join("\n")}\n`);
    await createHeartbeatJob(HEARTBEAT, deps()).run(scheduled);
    const [input] = runnerCalls;
    expect(input!.agentName).toBe("job:heartbeat");
    expect(input!.contextFiles).toEqual(["AGENTS.md", "USER.md"]);
    expect(input!.readOnlyTools).toEqual({});
    expect(input!.prompt.startsWith(HEARTBEAT_PROMPT)).toBe(true);
    expect(input!.prompt).toContain("memory/2026-09-29.md, last 15 lines");
    expect(input!.prompt).toContain("- note 19");
    expect(input!.prompt).not.toContain("- note 4\n");
    expect(input!.prompt).not.toContain("old note");
    expect(input!.systemPrompt).toContain('scheduled job "heartbeat"');
    expect(input!.systemPrompt).toContain("read-only");
    expect(input!.systemPrompt).toContain("Tue, 29/09/2026, 12:00 (UTC)");
  });

  test("the daily task review runs first and shares the proactive cap; a failing review can't break the heartbeat", async () => {
    const d = deps({ config: config({ proactiveDailyCap: 1 }) });
    const order: string[] = [];
    reply = "Something worth saying.";
    const review = async () => {
      order.push("review");
      d.limiter.record("task-review", clock);
    };
    const outcome = await createHeartbeatJob(HEARTBEAT, { ...d, review, runner: async (c, i) => (order.push("prompt"), fakeRunner(c, i)) }).run(scheduled);
    // The review's ask used the day's only proactive slot, so the capped heartbeat doesn't even run its prompt.
    expect(order).toEqual(["review"]);
    expect(outcome).toEqual({ status: "rate_limited", summary: "daily_cap" });
    expect(delivered).toEqual([]);

    const failing = await createHeartbeatJob(HEARTBEAT, { ...deps(), review: () => Promise.reject(new Error("boom")) }).run(scheduled);
    expect(failing.status).toBe("sent");
    expect(runnerCalls).toHaveLength(1);
  });

  test("a reply is delivered as a proactive message and noted in the chat", async () => {
    reply = "Your passport renewal is due Friday; the form is still in scratch/.";
    const outcome = await createHeartbeatJob(HEARTBEAT, deps()).run(scheduled);
    expect(outcome.status).toBe("sent");
    expect(delivered).toEqual([reply]);
    expect(notes).toEqual([{ name: "heartbeat", text: `[scheduled job heartbeat] You sent drk this proactive message: ${reply}` }]);
  });

  test("a failed chat note doesn't fail the job or unsend the message", async () => {
    reply = "Heads up.";
    const outcome = await createHeartbeatJob(HEARTBEAT, deps({ note: () => Promise.reject(new Error("no session")) })).run(scheduled);
    expect(outcome.status).toBe("sent");
    expect(delivered).toEqual(["Heads up."]);
  });

  test("a multi-line reply's chat note is one clipped line", async () => {
    reply = `line one\n\nline two ${"x".repeat(400)}`;
    await createHeartbeatJob(HEARTBEAT, deps()).run(scheduled);
    expect(notes[0]!.text).not.toContain("\n");
    expect(notes[0]!.text.endsWith("…")).toBe(true);
    expect(delivered[0]).toBe(reply);
  });
});

describe("rate limits", () => {
  test("one message per job per window: the next run inside the window is dropped, before the model runs", async () => {
    reply = "ping";
    const d = deps();
    const job = createHeartbeatJob(HEARTBEAT, d);
    expect((await job.run(scheduled)).status).toBe("sent");
    clock = new Date("2026-09-29T13:59:00Z");
    expect(await job.run(scheduled)).toEqual({ status: "rate_limited", summary: "job_window" });
    expect(runnerCalls).toHaveLength(1);
    clock = new Date("2026-09-29T14:00:00Z");
    expect((await job.run(scheduled)).status).toBe("sent");
    expect(delivered).toHaveLength(2);
  });

  test("the window doesn't count runs that sent nothing", async () => {
    const job = createHeartbeatJob(HEARTBEAT, deps());
    await job.run(scheduled);
    reply = "now something";
    clock = new Date("2026-09-29T12:30:00Z");
    expect((await job.run(scheduled)).status).toBe("sent");
  });

  test("a manual run skips the job window but never the daily cap", async () => {
    reply = "ping";
    const job = createHeartbeatJob(HEARTBEAT, deps({ config: config({ proactiveDailyCap: 2 }) }));
    await job.run(scheduled);
    clock = new Date("2026-09-29T12:10:00Z");
    expect((await job.run({ trigger: "manual", force: true })).status).toBe("sent");
    clock = new Date("2026-09-29T12:20:00Z");
    expect(await job.run({ trigger: "manual", force: true })).toEqual({ status: "rate_limited", summary: "daily_cap" });
    expect(delivered).toHaveLength(2);
  });

  test("the daily cap is global across jobs, rolling over 24 h, and survives a restart", async () => {
    reply = "ping";
    const cfg = config({ proactiveDailyCap: 3 });
    const every10: JobSchedule = { when: { kind: "every", minutes: 10 } };
    const jobs = ["a", "b", "c", "d"].map((name) => createPromptJob({ name, prompt: "p", schedule: every10 }, deps({ config: cfg })));
    const outcomes = [];
    for (const job of jobs) outcomes.push((await job.run(scheduled)).status);
    expect(outcomes).toEqual(["sent", "sent", "sent", "rate_limited"]);

    // A fresh limiter (a restart) reads the same state.
    const again = createPromptJob({ name: "e", prompt: "p", schedule: every10 }, deps({ config: cfg }));
    expect((await again.run(scheduled)).status).toBe("rate_limited");
    clock = new Date("2026-09-30T12:00:01Z");
    expect((await again.run(scheduled)).status).toBe("sent");
  });

  test("a daily job's window is under a day, so a DST-short day still sends", () => {
    const limiter = new ProactiveLimiter(join(root, "state"), 6);
    limiter.record("brief", new Date("2027-03-13T13:00:00Z"));
    expect(limiter.check("brief", DAILY_JOB_WINDOW_MS, new Date("2027-03-14T12:00:00Z"))).toBe("ok");
    expect(limiter.check("brief", DAILY_JOB_WINDOW_MS, new Date("2027-03-14T08:00:00Z"))).toBe("job_window");
  });
});

describe("recentDailyNotes", () => {
  test("empty without notes; only YYYY-MM-DD.md files count", () => {
    expect(recentDailyNotes(join(root, "home"))).toBe("");
    writeFileSync(join(root, "home", "memory", "zzz.md"), "- not a daily note\n");
    expect(recentDailyNotes(join(root, "home"))).toBe("");
  });
});

describe("wireProactiveJobs", () => {
  function wire(cfg: WorkspaceConfig, onScheduleChange?: () => void): Scheduler {
    const scheduler = new Scheduler({ stateDir: cfg.stateDir, at: "04:00", tz: "UTC", now: () => clock });
    wireProactiveJobs(scheduler, {
      config: cfg,
      runs: new RunLog(cfg.stateDir),
      selector: new BackendSelector({ primaryEnabled: false }),
      deliver: (t) => delivered.push(t),
      note: async (name, text) => {
        notes.push({ name, text });
      },
      runner: fakeRunner,
      now: () => clock,
      ...(onScheduleChange ? { onScheduleChange } : {}),
    });
    return scheduler;
  }

  test("heartbeat plus schedule.md jobs: scheduled, manual, hot-reloaded", async () => {
    const cfg = config();
    const path = join(cfg.home, "schedule.md");
    writeFileSync(path, "## brief\nwhen: daily 18:00\nenabled: false\n\nBrief drk.\n\n## heartbeat\nwhen: every 10m\n\nshadow\n");
    utimesSync(path, new Date(1_000_000), new Date(1_000_000));
    let changes = 0;
    const scheduler = wire(cfg, () => changes++);
    try {
      await scheduler.start();
      expect(readJobIndex(cfg.stateDir)).toEqual([
        { name: "heartbeat", schedule: "every 120m, active 08:00-22:00" },
        { name: "brief", schedule: "daily 18:00 (disabled)" },
      ]);

      await scheduler.tick();
      expect(runnerCalls.map((c) => c.agentName)).toEqual(["job:heartbeat"]);
      expect(runnerCalls[0]!.prompt).not.toContain("shadow");
      expect(delivered).toEqual([]);

      // A disabled job still runs on request.
      reply = "Brief text";
      requestRun(cfg.stateDir, "brief");
      await scheduler.tick();
      expect(runnerCalls.map((c) => c.agentName)).toEqual(["job:heartbeat", "job:brief"]);
      expect(delivered).toEqual(["Brief text"]);
      expect(notes.map((n) => n.name)).toEqual(["brief"]);
      expect(readSchedulerState(cfg.stateDir).jobs.brief).toMatchObject({ lastTrigger: "manual", lastStatus: "sent" });

      writeFileSync(path, "## brief\nwhen: daily 18:00\n\nBrief drk, please.\n");
      utimesSync(path, new Date(2_000_000), new Date(2_000_000));
      clock = new Date("2026-09-30T18:00:30Z");
      reply = "NO_REPLY";
      await scheduler.tick();
      expect(readJobIndex(cfg.stateDir)!.find((j) => j.name === "brief")!.schedule).toBe("daily 18:00");
      const brief = runnerCalls.filter((c) => c.agentName === "job:brief").at(-1)!;
      expect(brief.prompt.startsWith("Brief drk, please.")).toBe(true);
      expect(readSchedulerState(cfg.stateDir).jobs.brief).toMatchObject({ lastTrigger: "daily", lastStatus: "no_reply" });
      expect(changes).toBe(2);
    } finally {
      await scheduler.stop();
    }
  });

  test("no heartbeat when disabled", async () => {
    const scheduler = wire(config({ heartbeat: null }));
    await scheduler.start();
    expect(readJobIndex(join(root, "state"))).toEqual([]);
    await scheduler.stop();
  });
});

describe("config", () => {
  const base = { ORCH_SECRET: "s", OPENAI_API_KEY: "k", HOME: "/tmp/h" };

  test("defaults: heartbeat every 120 min, 08:00-22:00, cap 6", () => {
    const cfg = loadWorkspaceConfig(base);
    expect(cfg.heartbeat).toEqual(HEARTBEAT);
    expect(cfg.proactiveDailyCap).toBe(6);
  });

  test("overrides and off", () => {
    expect(loadWorkspaceConfig({ ...base, WORKSPACE_HEARTBEAT_EVERY: "off" }).heartbeat).toBeNull();
    expect(loadWorkspaceConfig({ ...base, WORKSPACE_HEARTBEAT_EVERY: "0" }).heartbeat).toBeNull();
    expect(loadWorkspaceConfig({ ...base, WORKSPACE_HEARTBEAT_EVERY: "90", WORKSPACE_HEARTBEAT_ACTIVE: "always" }).heartbeat).toEqual({
      when: { kind: "every", minutes: 90 },
    });
    expect(loadWorkspaceConfig({ ...base, WORKSPACE_HEARTBEAT_EVERY: "3h", WORKSPACE_HEARTBEAT_ACTIVE: "09:00-17:00" }).heartbeat).toEqual({
      when: { kind: "every", minutes: 180 },
      active: { start: "09:00", end: "17:00" },
    });
    expect(loadWorkspaceConfig({ ...base, WORKSPACE_PROACTIVE_DAILY_CAP: "2" }).proactiveDailyCap).toBe(2);
  });

  test("bad values fail loudly", () => {
    expect(() => loadWorkspaceConfig({ ...base, WORKSPACE_HEARTBEAT_EVERY: "1" })).toThrow(WorkspaceConfigError);
    expect(() => loadWorkspaceConfig({ ...base, WORKSPACE_HEARTBEAT_ACTIVE: "daytime" })).toThrow(WorkspaceConfigError);
    expect(() => loadWorkspaceConfig({ ...base, WORKSPACE_PROACTIVE_DAILY_CAP: "lots" })).toThrow(WorkspaceConfigError);
  });
});
