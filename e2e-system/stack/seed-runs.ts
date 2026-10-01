// Runs and ~/history the workspace starts with (flows/runs-history). Shared by the runner (bun) and the
// flows (node), so it must not import bun:* modules. Times are UTC, like the stack's WORKSPACE_TZ.
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEED = {
  /** A scheduled job run on 2025-01-02 09:00 UTC (the ULID's time part encodes that minute). */
  jobRunId: "01JGK3WEM0E2E0000000000001",
  /** Its subagent, a minute later, which failed. */
  childRunId: "01JGK3Y970E2E0000000000002",
  jobName: "e2e-nightly",
  date: "2025-01-02",
  needle: "E2E-NOTES-NEEDLE",
  /** Only in files planted outside ~/history and linked in; must never come back. */
  secret: "E2E-SECRET-MARKER",
} as const;

const at = (min: number, sec = 0) => new Date(Date.UTC(2025, 0, 2, 9, min, sec)).toISOString();

export function seedRunsAndHistory(p: { wsState: string; wsHome: string; piAgent: string; outside: string }): void {
  const sessionFile = join(p.piAgent, "job-sessions", "2025-01-02T09-00-00-000Z_e2e-job.jsonl");
  mkdirSync(join(p.piAgent, "job-sessions"), { recursive: true });
  const entries = [
    { type: "session", version: 3, id: "e2e-job", timestamp: at(0), cwd: p.wsHome },
    { type: "message", id: "j1", parentId: null, timestamp: at(0, 1), message: { role: "user", content: "Run the nightly check" } },
    {
      type: "message",
      id: "j2",
      parentId: "j1",
      timestamp: at(0, 2),
      message: { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "cd projects/app && bun test" } }], stopReason: "toolUse" },
    },
    { type: "message", id: "j3", parentId: "j2", timestamp: at(0, 4), message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "12 pass" }], isError: false } },
    { type: "message", id: "j4", parentId: "j3", timestamp: at(0, 5), message: { role: "assistant", content: [{ type: "text", text: "E2E-RUNS nightly finished." }], stopReason: "stop" } },
  ];
  writeFileSync(sessionFile, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

  mkdirSync(p.wsState, { recursive: true });
  const records = [
    { runId: SEED.jobRunId, agentName: `job:${SEED.jobName}`, task: "Run the nightly check", sessionFile, startedAt: at(0), status: "running" },
    { runId: SEED.childRunId, parentRunId: SEED.jobRunId, agentName: "explore", task: "look around", sessionFile: join(p.piAgent, "subagents", "gone.jsonl"), startedAt: at(1), status: "running" },
    { runId: SEED.childRunId, parentRunId: SEED.jobRunId, agentName: "explore", task: "look around", sessionFile: join(p.piAgent, "subagents", "gone.jsonl"), startedAt: at(1), endedAt: at(2), status: "failed", resultSummary: "it broke" },
    { runId: SEED.jobRunId, agentName: `job:${SEED.jobName}`, task: "Run the nightly check", sessionFile, startedAt: at(0), endedAt: at(0, 6), status: "done", usage: { inputTokens: 100, outputTokens: 10 } },
  ];
  writeFileSync(join(p.wsState, "runs.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const hist = join(p.wsHome, "history");
  mkdirSync(join(hist, "2025-01"), { recursive: true });
  writeFileSync(
    join(hist, `${SEED.date}.md`),
    [
      `# ${SEED.date}`,
      "",
      "## Runs",
      "",
      `- 09:00 job/job:${SEED.jobName} — Run the nightly check (1 tool, done) [${SEED.jobRunId}](2025-01/02-${SEED.jobRunId}.md)`,
      "",
      "## Sessions",
      "",
      "### 09:30 · rotate · nightly · `e2e.jsonl`",
      "",
      `#### Goals`,
      `- recap mentions ${SEED.needle} in the daily notes`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(hist, "2025-01", `02-${SEED.jobRunId}.md`),
    `# job run ${SEED.jobRunId}\n\n- **When:** 2025-01-02 09:00 → 09:00 (UTC)\n- **Agent:** job / job:${SEED.jobName}\n- **Status:** done\n\n## Transcript\n\n### user · 09:00\n\nRun the nightly check, ${SEED.needle} in the run file\n`,
  );

  mkdirSync(p.outside, { recursive: true });
  const outsideFile = join(p.outside, "auth.json");
  writeFileSync(outsideFile, `{"token":"${SEED.secret}","note":"${SEED.needle}"}\n`);
  symlinkSync(outsideFile, join(hist, "2025-01-03.md"));
  linkSync(outsideFile, join(hist, "2025-01-04.md"));
}
