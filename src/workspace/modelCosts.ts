import type { HistoryCost, ModelCosts } from "../orchestration/contracts.ts";
import { localTime } from "./history.ts";
import { runLogPath, type RunRecord } from "./runLog.ts";
import { scanRunIndex } from "./runReader.ts";

function total(runs: Iterable<RunRecord>): HistoryCost {
  const cost: HistoryCost = { usd: 0, recordedRuns: 0, unpricedRuns: 0 };
  for (const run of runs) {
    const usd = run.usage?.costUsd;
    if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
      cost.usd += usd;
      cost.recordedRuns++;
    } else cost.unpricedRuns++;
  }
  return cost;
}

/** Recorded per-run costs, never provider rates or inclusive parent totals. */
export async function readModelCosts(opts: {
  stateDir: string;
  timeZone: string;
  sessionFile: string | null;
  now?: Date;
}): Promise<ModelCosts> {
  const date = localTime(opts.now ?? new Date(), opts.timeZone).date;
  const index = await scanRunIndex(runLogPath(opts.stateDir));
  const dates = new Intl.DateTimeFormat("en-CA", { timeZone: opts.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  // Rotation entries record a context transition, rather than a model run.
  const runs = [...index.runs.values()].filter(run => run.agentName !== "main:rotate");
  const today = runs.filter(run => {
    const startedAt = new Date(run.startedAt);
    if (!Number.isFinite(startedAt.getTime())) return false;
    const parts = dates.formatToParts(startedAt);
    const part = (type: string) => parts.find(p => p.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}` === date;
  });
  let session: HistoryCost | undefined;
  if (opts.sessionFile) {
    const selected = new Set(runs.filter(run => run.sessionFile === opts.sessionFile).map(run => run.runId));
    const children = new Map<string, string[]>();
    for (const run of runs) {
      if (!run.parentRunId) continue;
      const group = children.get(run.parentRunId) ?? [];
      group.push(run.runId);
      children.set(run.parentRunId, group);
    }
    const queue = [...selected];
    for (let i = 0; i < queue.length; i++) {
      for (const id of children.get(queue[i]!) ?? []) {
        if (selected.has(id)) continue;
        selected.add(id);
        queue.push(id);
      }
    }
    session = total(runs.filter(run => selected.has(run.runId)));
  }
  return {
    ...(session ? { session } : {}),
    today: total(today),
    date,
    timeZone: opts.timeZone,
    ...(index.truncated ? { truncated: true } : {}),
  };
}
