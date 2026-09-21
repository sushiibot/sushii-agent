import type { TaskRow } from "./contracts.ts";
import type { TaskMeta } from "./activityHub.ts";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A copy-paste terminal command to resume the task's native session, or null when it isn't cleanly
 *  resumable outside the bot. Claude Code resumes by session id in the cwd; Pi's resume needs a
 *  session id + session-dir inside the runner container, so a bare terminal command isn't reliable
 *  — resume those through the bot instead. */
export function buildResumeCommand(kind: string, cwd: string | null, nativeSessionId: string | null): string | null {
  if (!nativeSessionId) return null;
  if (kind === "claude-code" && cwd) return `cd ${shellQuote(cwd)} && claude --resume ${nativeSessionId}`;
  return null;
}

export function buildTaskMeta(task: TaskRow, info: { kind: string; location: string | null } | undefined): TaskMeta {
  const kind = info?.kind ?? "?";
  return {
    runnerId: task.runnerId,
    kind,
    location: info?.location ?? null,
    project: task.project,
    cwd: task.cwd,
    nativeSessionId: task.nativeSessionId,
    resumeCommand: buildResumeCommand(kind, task.cwd, task.nativeSessionId),
  };
}
