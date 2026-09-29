import { readSchedulerState, requestRun } from "./scheduler.ts";
import { resolveStateDir } from "./sessionPaths.ts";

// The consolidation itself runs in the workspace process, which holds the model credentials this shell doesn't;
// the CLI only queues a request for the scheduler and reads back its last result.

const JOB = "consolidation";

const USAGE = `usage:
  ws-consolidate --now      queue a memory consolidation now (skips the size gate, never the checks)
  ws-consolidate --status   show the last consolidation run`;

export interface WsConsolidateIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => Date;
}

export function runWsConsolidate(argv: string[], io: WsConsolidateIo): number {
  const cmd = argv[0];
  if (argv.length !== 1 || (cmd !== "--now" && cmd !== "--status")) {
    io.err(USAGE);
    return 2;
  }
  const stateDir = resolveStateDir(io.env);
  if (!stateDir) {
    io.err("ws-consolidate: HOME is not set");
    return 1;
  }
  if (cmd === "--now") {
    requestRun(stateDir, JOB, io.now?.() ?? new Date());
    io.out("queued: the workspace starts it within a minute. The result lands in ~/DREAMS.md; check with ws-consolidate --status.");
    return 0;
  }
  const last = readSchedulerState(stateDir).jobs[JOB];
  if (!last) {
    io.out("no consolidation has run yet");
    return 0;
  }
  io.out(`last run: ${last.lastRunAt} (${last.lastTrigger}) → ${last.lastStatus}`);
  if (last.lastSummary) io.out(last.lastSummary);
  return 0;
}
