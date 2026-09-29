import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "../logger.ts";
import type { WorkspaceConfig } from "./config.ts";
import { isNoReply, NO_REPLY } from "./events.ts";
import { readJson, writeFileAtomic } from "./files.ts";
import { runToolFreeJob } from "./jobSession.ts";
import type { BackendSelector } from "./chatgptFallback.ts";
import type { RunRecorder } from "./runLog.ts";
import { ScheduleFile, type ScheduleEntry } from "./scheduleFile.ts";
import type { JobContext, JobOutcome, JobSchedule, ScheduledJob, Scheduler } from "./scheduler.ts";
import type { ToolStubs } from "./toolStubs.ts";

export { isNoReply, NO_REPLY };

const log = getLogger("workspace.proactive");

export const HEARTBEAT_JOB = "heartbeat";
export const HEARTBEAT_PROMPT =
  "Check whether anything needs drk's attention right now: something due or overdue, a follow-up you promised, " +
  "or a change worth flagging. Look in MEMORY.md and the recent daily notes when it helps. If nothing does, reply NO_REPLY.";
/** Names schedule.md can't use: the built-in jobs. */
export const RESERVED_JOB_NAMES = [HEARTBEAT_JOB, "consolidation"] as const;
/** A daily job's window for the one-message-per-window limit; under 24 h so a DST day's 23 h gap still sends. */
export const DAILY_JOB_WINDOW_MS = 20 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const NOTE_LINES = 15;
const NOTE_LINE_MAX = 300;
const CONTEXT_NOTE_MAX = 300;
const DAILY_NOTE = /^\d{4}-\d{2}-\d{2}\.md$/;

export function jobWindowMs(schedule: JobSchedule): number {
  return schedule.when.kind === "every" ? schedule.when.minutes * 60_000 : DAILY_JOB_WINDOW_MS;
}

export type LimitVerdict = "ok" | "job_window" | "daily_cap";

interface LimiterState {
  lastByJob: Record<string, string>;
  sent: string[];
}

/** Proactive-message rate limits, persisted so a restart doesn't reset them: one per job per window, and a rolling 24 h cap across jobs. */
export class ProactiveLimiter {
  private readonly path: string;

  constructor(
    stateDir: string,
    private readonly dailyCap: number,
  ) {
    this.path = join(stateDir, "proactive.json");
  }

  /** `skipJobWindow` is for manual runs; the daily cap always applies. */
  check(job: string, windowMs: number, at: Date, skipJobWindow = false): LimitVerdict {
    const state = this.read(at);
    if (state.sent.length >= this.dailyCap) return "daily_cap";
    const last = state.lastByJob[job];
    if (!skipJobWindow && last && at.getTime() - Date.parse(last) < windowMs) return "job_window";
    return "ok";
  }

  record(job: string, at: Date): void {
    const state = this.read(at);
    state.lastByJob[job] = at.toISOString();
    state.sent.push(at.toISOString());
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }

  private read(at: Date): LimiterState {
    const raw = readJson<Partial<LimiterState>>(this.path);
    const sent = Array.isArray(raw?.sent) ? raw.sent.filter((t) => typeof t === "string" && at.getTime() - Date.parse(t) < DAY_MS) : [];
    const lastByJob = raw?.lastByJob && typeof raw.lastByJob === "object" ? raw.lastByJob : {};
    return { lastByJob, sent };
  }
}

/** The last few lines of the newest daily note, or "" when there is none. */
export function recentDailyNotes(home: string, maxLines = NOTE_LINES): string {
  let names: string[];
  try {
    names = readdirSync(join(home, "memory")).filter((n) => DAILY_NOTE.test(n));
  } catch {
    return "";
  }
  const newest = names.sort().at(-1);
  if (!newest) return "";
  let text: string;
  try {
    text = readFileSync(join(home, "memory", newest), "utf8");
  } catch {
    return "";
  }
  const lines = text
    .split("\n")
    .filter((l) => l.trim())
    .slice(-maxLines)
    .map((l) => (l.length > NOTE_LINE_MAX ? `${l.slice(0, NOTE_LINE_MAX - 1)}…` : l));
  return lines.length ? `Recent daily notes (memory/${newest}, last ${lines.length} lines):\n${lines.join("\n")}` : "";
}

function localTime(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

export function jobPreamble(name: string, now: Date, tz: string): string {
  return [
    `You are drk's personal agent, running the scheduled job "${name}" on your own, outside the chat with drk.`,
    `It is ${localTime(now, tz)} (${tz}).`,
    "",
    "- This run is read-only: you can read files in your home (MEMORY.md, memory/, schedule.md, ...) and use the bot tools offered,",
    "  but you can't run commands, edit files or write memory, whatever the operating manual below says.",
    "- Don't call tools that need drk's approval.",
    `- When nothing is worth drk's attention right now, reply with exactly ${NO_REPLY} and nothing else.`,
    "- Otherwise your reply is sent to drk as-is, as an unprompted chat message: short, the point first, and why it matters now.",
    "",
    "Your operating manual and drk's profile follow.",
  ].join("\n");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface PromptJobSpec {
  name: string;
  prompt: string;
  schedule: JobSchedule;
}

export interface PromptJobDeps {
  config: WorkspaceConfig;
  runs: RunRecorder;
  selector: BackendSelector;
  toolStubs?: ToolStubs;
  limiter: ProactiveLimiter;
  /** Sends `text` to drk as a proactive message. */
  deliver: (text: string) => void;
  /** Appends a one-line note to the main chat session. */
  note: (name: string, text: string) => Promise<void>;
  /** Test seam. */
  runner?: typeof runToolFreeJob;
  now?: () => Date;
}

/**
 * A scheduled prompt in a light, read-only session (AGENTS.md, USER.md, the prompt and recent daily notes;
 * never the chat history). A reply other than NO_REPLY goes to drk within the rate limits, with a note in the chat.
 */
export function createPromptJob(spec: PromptJobSpec, deps: PromptJobDeps): ScheduledJob {
  const agentName = `job:${spec.name}`;
  const windowMs = jobWindowMs(spec.schedule);
  return {
    name: spec.name,
    schedule: spec.schedule,
    async run(ctx: JobContext): Promise<JobOutcome> {
      const now = deps.now?.() ?? new Date();
      // Checked before the model runs too, so a capped job spends nothing.
      const before = deps.limiter.check(spec.name, windowMs, now, ctx.force);
      if (before !== "ok") return { status: "rate_limited", summary: before };

      const notes = recentDailyNotes(deps.config.home);
      const prompt = notes ? `${spec.prompt}\n\n${notes}` : spec.prompt;
      const { text } = await (deps.runner ?? runToolFreeJob)(deps.config, {
        agentName,
        systemPrompt: jobPreamble(spec.name, now, deps.config.tz),
        prompt,
        runs: deps.runs,
        selector: deps.selector,
        contextFiles: ["AGENTS.md", "USER.md"],
        readOnlyTools: deps.toolStubs ? { toolStubs: deps.toolStubs } : {},
      });
      if (isNoReply(text)) return { status: "no_reply" };

      const verdict = deps.limiter.check(spec.name, windowMs, now, ctx.force);
      if (verdict !== "ok") {
        log.warn({ job: spec.name, verdict }, "proactive message dropped by the rate limit");
        return { status: "rate_limited", summary: verdict };
      }
      deps.limiter.record(spec.name, now);
      deps.deliver(text);
      try {
        await deps.note(spec.name, `[scheduled job ${spec.name}] You sent drk this proactive message: ${oneLine(text, CONTEXT_NOTE_MAX)}`);
      } catch (err) {
        log.warn({ err, job: spec.name }, "failed to note a proactive message in the chat");
      }
      return { status: "sent", summary: oneLine(text, 200) };
    },
  };
}

export function createHeartbeatJob(schedule: JobSchedule, deps: PromptJobDeps): ScheduledJob {
  return createPromptJob({ name: HEARTBEAT_JOB, prompt: HEARTBEAT_PROMPT, schedule }, deps);
}

/** Jobs from schedule.md, rebuilt only when the file's entries change. */
export function scheduleFileSource(file: ScheduleFile, deps: PromptJobDeps): () => ScheduledJob[] {
  let entries: ScheduleEntry[] | null = null;
  let jobs: ScheduledJob[] = [];
  return () => {
    const next = file.entries();
    if (next !== entries) {
      entries = next;
      jobs = next.map((e) => createPromptJob(e, deps));
    }
    return jobs;
  };
}

export interface ProactiveWiring {
  config: WorkspaceConfig;
  runs: RunRecorder;
  selector: BackendSelector;
  toolStubs?: ToolStubs;
  deliver: (text: string) => void;
  note: (name: string, text: string) => Promise<void>;
  /** After schedule.md is found changed, e.g. to commit it. */
  onScheduleChange?: () => void;
  /** Test seams. */
  runner?: PromptJobDeps["runner"];
  now?: () => Date;
}

/** Registers the heartbeat (when enabled) and the schedule.md jobs on `scheduler`. */
export function wireProactiveJobs(scheduler: Scheduler, w: ProactiveWiring): void {
  const deps: PromptJobDeps = {
    config: w.config,
    runs: w.runs,
    selector: w.selector,
    ...(w.toolStubs ? { toolStubs: w.toolStubs } : {}),
    limiter: new ProactiveLimiter(w.config.stateDir, w.config.proactiveDailyCap),
    deliver: w.deliver,
    note: w.note,
    ...(w.runner ? { runner: w.runner } : {}),
    ...(w.now ? { now: w.now } : {}),
  };
  if (w.config.heartbeat) scheduler.register(createHeartbeatJob(w.config.heartbeat, deps));
  const file = new ScheduleFile(join(w.config.home, "schedule.md"), {
    reserved: RESERVED_JOB_NAMES,
    warn: (error) => log.warn({ error }, "skipped a schedule.md entry"),
    ...(w.onScheduleChange ? { onChange: w.onScheduleChange } : {}),
  });
  scheduler.addSource(scheduleFileSource(file, deps));
}
