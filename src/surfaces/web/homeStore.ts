import type { Database, Statement } from "bun:sqlite";
import type { HomeAlert, HomeMessage, JobAlert } from "./events.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longer than HOME_RECENT_HOURS, so a run stays opened for as long as Home could list it. */
export const OPENED_RUNS_RETENTION_MS = 30 * DAY_MS;
export const DISMISSED_RUNS_RETENTION_MS = 7 * DAY_MS;
export const CLEARED_ALERTS_RETENTION_MS = 30 * DAY_MS;
export const DONE_MESSAGES_RETENTION_MS = 30 * DAY_MS;
/** Undone messages Home lists; older ones wait behind them. */
export const HOME_MESSAGES_MAX = 50;

type MessageRow = { key: string; job: string; run_id: string | null; text: string; at: number; read_at: number | null };
type AlertRow = { job: string; state: "open" | "cleared"; alert: string; first_at: string; seq: number; key: string; dismissed_at: number | null; updated_at: number };

const startedMs = (a: { startedAt: string }) => Date.parse(a.startedAt);

/** What a delivered alert did to its job's row. */
export type AlertChange = "opened" | "cleared" | "stale" | "noop";

/** Home's own state: job-alert streaks (`web_alerts`), job messages (`web_inbox`), dismissed and opened runs. */
export class WebHomeStore {
  private readonly now: () => number;
  private readonly q: {
    alert: Statement<AlertRow, [string]>;
    upsert: Statement<unknown, [string, string, string, number, string, number]>;
    clear: Statement<unknown, [number, string, string]>;
    record: Statement<unknown, [string, string, string, number, string, number]>;
    open: Statement<AlertRow, []>;
    dismiss: Statement<unknown, [number, number, string]>;
  };

  constructor(
    private readonly db: Database,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.q = {
      alert: db.query("SELECT * FROM web_alerts WHERE job = ?"),
      upsert: db.query(
        `INSERT INTO web_alerts (job, state, alert, first_at, seq, key, dismissed_at, updated_at) VALUES (?, 'open', ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(job) DO UPDATE SET state = 'open', alert = excluded.alert, first_at = excluded.first_at, seq = excluded.seq,
         key = excluded.key, dismissed_at = NULL, updated_at = excluded.updated_at`,
      ),
      clear: db.query("UPDATE web_alerts SET state = 'cleared', updated_at = ?, alert = ? WHERE job = ?"),
      // A recovery with no open streak still sets the job's newest run, so an older failure is stale.
      record: db.query(
        `INSERT INTO web_alerts (job, state, alert, first_at, seq, key, dismissed_at, updated_at) VALUES (?, 'cleared', ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(job) DO UPDATE SET alert = excluded.alert, updated_at = excluded.updated_at`,
      ),
      open: db.query("SELECT * FROM web_alerts WHERE state = 'open' AND dismissed_at IS NULL ORDER BY seq DESC"),
      dismiss: db.query("UPDATE web_alerts SET dismissed_at = ?, updated_at = ? WHERE job = ? AND state = 'open' AND dismissed_at IS NULL"),
    };
  }

  /**
   * Records a delivered alert; run it in the transaction that appends the alert's event. The row keeps the
   * newest alert it has seen per job, whatever its kind, so an alert about an older run is `stale` however
   * the deliveries were reordered. `failed`/`stuck` open or extend the streak and undo a dismissal; `recovered`
   * closes an open one.
   */
  applyAlert(alert: JobAlert, seq: number, key: string): AlertChange {
    const row = this.q.alert.get(alert.job);
    if (row && startedMs(alert) < startedMs(JSON.parse(row.alert) as JobAlert)) return "stale";
    if (alert.kind === "recovered") {
      if (row?.state === "open") {
        this.q.clear.run(this.now(), JSON.stringify(alert), alert.job);
        return "cleared";
      }
      this.q.record.run(alert.job, JSON.stringify(alert), alert.startedAt, seq, key, this.now());
      return "noop";
    }
    const firstAt = row?.state === "open" ? row.first_at : alert.startedAt;
    this.q.upsert.run(alert.job, JSON.stringify(alert), firstAt, seq, key, this.now());
    return "opened";
  }

  /** Open, undismissed streaks, newest alert first. */
  openAlerts(): HomeAlert[] {
    return this.q.open.all().map((r) => {
      const a = JSON.parse(r.alert) as JobAlert;
      return {
        id: `job:${r.job}`,
        job: r.job,
        kind: a.kind === "stuck" ? "stuck" : "failed",
        firstAt: r.first_at,
        lastAt: a.startedAt,
        trigger: a.trigger,
        ...(a.error !== undefined ? { error: a.error } : {}),
        schedule: a.schedule,
        ...(a.disabled ? { disabled: true } : {}),
        ...(a.runId ? { runId: a.runId } : {}),
        seq: r.seq,
      };
    });
  }

  /** Hides an open streak until its next failure. Null when there is no open, undismissed streak for `job`;
   *  otherwise the seq of the alert it hid. */
  dismissAlert(job: string): number | null {
    const row = this.q.alert.get(job);
    if (!row || row.state !== "open" || row.dismissed_at !== null) return null;
    const now = this.now();
    this.q.dismiss.run(now, now, job);
    return row.seq;
  }

  /** Files a job's message; false when its key is already filed. */
  addMessage(m: { key: string; job: string; runId?: string; text: string }): boolean {
    const res = this.db.run("INSERT INTO web_inbox (key, job, run_id, text, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING", [
      m.key,
      m.job,
      m.runId ?? null,
      m.text,
      this.now(),
    ]);
    return res.changes > 0;
  }

  hasMessage(key: string): boolean {
    return this.db.query("SELECT 1 FROM web_inbox WHERE key = ?").get(key) !== null;
  }

  /** Messages not marked done, newest first. */
  messages(): HomeMessage[] {
    const rows = this.db
      .query("SELECT key, job, run_id, text, at, read_at FROM web_inbox WHERE done_at IS NULL ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(HOME_MESSAGES_MAX) as MessageRow[];
    return rows.map((r) => ({
      key: r.key,
      job: r.job,
      ...(r.run_id ? { runId: r.run_id } : {}),
      text: r.text,
      at: new Date(r.at).toISOString(),
      read: r.read_at !== null,
    }));
  }

  /** False when there is no such message. */
  readMessage(key: string): boolean {
    return this.db.run("UPDATE web_inbox SET read_at = COALESCE(read_at, ?) WHERE key = ?", [this.now(), key]).changes > 0;
  }

  /** Leaves `read` as it was, so Undo brings it back unchanged. False when there is no such message. */
  doneMessage(key: string): boolean {
    return this.db.run("UPDATE web_inbox SET done_at = COALESCE(done_at, ?) WHERE key = ?", [this.now(), key]).changes > 0;
  }

  /** False when there is no such message. */
  restoreMessage(key: string): boolean {
    return this.db.run("UPDATE web_inbox SET done_at = NULL WHERE key = ?", [key]).changes > 0;
  }

  dismissRun(runId: string): void {
    this.db.run("INSERT INTO web_dismissed_runs (run_id, at) VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING", [runId, this.now()]);
  }

  restoreRun(runId: string): void {
    this.db.run("DELETE FROM web_dismissed_runs WHERE run_id = ?", [runId]);
  }

  openRun(runId: string): void {
    this.db.run("INSERT INTO web_opened_runs (run_id, at) VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING", [runId, this.now()]);
  }

  /** The subset of `runIds` dismissed from Home. */
  dismissedRuns(runIds: readonly string[]): Set<string> {
    return this.subset("web_dismissed_runs", runIds);
  }

  /** The subset of `runIds` the owner has opened. */
  openedRuns(runIds: readonly string[]): Set<string> {
    return this.subset("web_opened_runs", runIds);
  }

  prune(now: number): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM web_opened_runs WHERE at < ?", [now - OPENED_RUNS_RETENTION_MS]);
      this.db.run("DELETE FROM web_dismissed_runs WHERE at < ?", [now - DISMISSED_RUNS_RETENTION_MS]);
      this.db.run("DELETE FROM web_alerts WHERE state = 'cleared' AND updated_at < ?", [now - CLEARED_ALERTS_RETENTION_MS]);
      this.db.run("DELETE FROM web_inbox WHERE done_at < ?", [now - DONE_MESSAGES_RETENTION_MS]);
    })();
  }

  private subset(table: "web_dismissed_runs" | "web_opened_runs", ids: readonly string[]): Set<string> {
    if (!ids.length) return new Set();
    const rows = this.db.query(`SELECT run_id FROM ${table} WHERE run_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { run_id: string }[];
    return new Set(rows.map((r) => r.run_id));
  }
}
