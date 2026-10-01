import type { Database } from "bun:sqlite";
import type { ApprovalDecision, ChatEventMap, RunApprovalRecord, RunSummary, UploadRef } from "./events.ts";

/** Run kinds whose tool calls the workspace sends as agent "main". */
const MAIN_SESSION_KINDS: ReadonlySet<RunSummary["kind"]> = new Set(["chat", "flush", "rotate"]);
export const RUN_APPROVALS_MAX = 100;
export const RUN_FILES_MAX = 100;

type Row = { key: string | null; data: string; created_at: number };

/**
 * Approvals from the bot's log that belong to `run`. Approval rows carry no turnId, so a subagent's are
 * matched by its runId, a job's by its agent name, and Main's by time inside the run's window.
 */
export function runApprovals(db: Database, run: RunSummary, now: number): RunApprovalRecord[] {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt !== undefined ? Date.parse(run.endedAt) : now;
  const windowed = Number.isFinite(start) && Number.isFinite(end);
  const windowAgent = MAIN_SESSION_KINDS.has(run.kind) ? "main" : run.kind === "job" ? run.agentName : null;
  const rows = db
    .query(
      `SELECT key, data, created_at FROM web_events WHERE type = 'approval' AND (
         json_extract(data, '$.view.agentId') = ?
         OR (? IS NOT NULL AND json_extract(data, '$.view.agentId') = ? AND created_at BETWEEN ? AND ?)
       ) ORDER BY seq LIMIT ?`,
    )
    .all(run.runId, windowed ? windowAgent : null, windowAgent, windowed ? start : 0, windowed ? end : 0, RUN_APPROVALS_MAX) as Row[];
  const approvals = rows.map((r) => ({ at: r.created_at, data: JSON.parse(r.data) as ChatEventMap["approval"] }));
  if (!approvals.length) return [];

  const nonces = approvals.flatMap((a) => [a.data.nonce, `${a.data.nonce}:result`]);
  const decisions = new Map<string, ApprovalDecision>();
  const resolved = db
    .query(`SELECT key, data, created_at FROM web_events WHERE type = 'approval_resolved' AND key IN (${nonces.map(() => "?").join(",")}) ORDER BY seq`)
    .all(...nonces) as Row[];
  for (const r of resolved) {
    const d = JSON.parse(r.data) as ChatEventMap["approval_resolved"];
    decisions.set(d.nonce, d.decision);
  }
  return approvals.map((a) => ({
    nonce: a.data.nonce,
    at: new Date(a.at).toISOString(),
    tool: a.data.view.tool,
    decision: decisions.get(a.data.nonce) ?? null,
  }));
}

/** Files the bot delivered on replies of the run's turn. A run without a turnId gets none. */
export function runFiles(db: Database, run: RunSummary): UploadRef[] {
  if (!run.turnId) return [];
  const rows = db
    .query(`SELECT key, data, created_at FROM web_events WHERE type IN ('reply','proactive') AND json_extract(data, '$.turnId') = ? ORDER BY seq`)
    .all(run.turnId) as Row[];
  const out: UploadRef[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const f of (JSON.parse(r.data) as ChatEventMap["reply"]).files ?? []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
      if (out.length >= RUN_FILES_MAX) return out;
    }
  }
  return out;
}
