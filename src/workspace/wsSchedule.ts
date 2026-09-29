import { isValidJobName, readJobIndex, readSchedulerState, requestRun } from "./scheduler.ts";
import { resolveStateDir } from "./sessionPaths.ts";

// Jobs run in the workspace process, which holds the model credentials this shell lacks. The CLI only
// queues requests and reads the job list and last runs the scheduler wrote.

const USAGE = `usage:
  ws-schedule list          show the scheduled jobs and their last runs
  ws-schedule run <job>     queue a run of <job> now (disabled jobs too; rate limits still apply)`;

export interface WsScheduleIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
}

export function runWsSchedule(argv: string[], io: WsScheduleIo): number {
  const [cmd, job] = argv;
  const valid = (cmd === "list" && argv.length === 1) || (cmd === "run" && argv.length === 2);
  if (!valid) {
    io.err(USAGE);
    return 2;
  }
  const stateDir = resolveStateDir(io.env);
  if (!stateDir) {
    io.err("ws-schedule: HOME is not set");
    return 1;
  }
  const index = readJobIndex(stateDir);
  if (cmd === "run") {
    if (!job || !isValidJobName(job)) {
      io.err(`ws-schedule: invalid job name: ${job ?? ""}`);
      return 1;
    }
    if (index && !index.some((j) => j.name === job)) {
      io.err(`ws-schedule: unknown job: ${job} (see ws-schedule list; a new schedule.md job loads within a minute)`);
      return 1;
    }
    requestRun(stateDir, job, io.now?.() ?? new Date());
    io.out(`queued: the workspace starts ${job} within a minute; check with ws-schedule list.`);
    return 0;
  }
  if (!index) {
    io.out("no job list yet: the workspace scheduler hasn't started");
    return 0;
  }
  const state = readSchedulerState(stateDir);
  for (const { name, schedule } of index) {
    const last = state.jobs[name];
    const lastText = last ? `last ${last.lastRunAt} (${last.lastTrigger}) → ${last.lastStatus}` : "never run";
    io.out(`${name}: ${schedule}; ${lastText}`);
    if (last?.lastSummary) io.out(`  ${last.lastSummary}`);
  }
  return 0;
}
