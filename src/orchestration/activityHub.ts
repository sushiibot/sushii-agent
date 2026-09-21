import { randomBytes, timingSafeEqual } from "node:crypto";

// In-memory live activity per task: a capped ring of recent lines + fan-out to live viewers (the
// Discord tail and the web stream). Not persisted — a task's stream lives only while it runs and for
// a short window after, which matches the no-catch-up model (a runner reconnect fails in-flight
// tasks anyway). The full transcript still lives in the runner's session file.

export interface ActivityLine {
  line: string;
  at: number;
  seq: number; // monotonic per task — the SSE event id, for de-dup + Last-Event-ID resume
}

interface TaskStream {
  token: string;
  lines: ActivityLine[];
  seq: number;
  status: string; // "running" | "idle" | "done" | "failed"
  summary: string | null;
  subscribers: Set<(l: ActivityLine) => void>;
  statusSubs: Set<(status: string, summary: string | null) => void>;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_LINES = 500; // ring cap per task (memory bound)
const RETAIN_AFTER_SETTLE_MS = 10 * 60_000; // keep a settled task's buffer this long for late viewers

export interface TaskView {
  lines: ActivityLine[];
  status: string;
  summary: string | null;
  /** Subscribe to new lines; returns an unsubscribe fn. */
  onLine: (cb: (l: ActivityLine) => void) => () => void;
  /** Subscribe to status/summary changes (settle); returns an unsubscribe fn. */
  onStatus: (cb: (status: string, summary: string | null) => void) => () => void;
}

export class ActivityHub {
  private readonly tasks = new Map<string, TaskStream>();

  /** Begin (or return) a task's stream; returns its viewer token. Idempotent. */
  open(taskId: string): string {
    let t = this.tasks.get(taskId);
    if (!t) {
      t = { token: randomBytes(16).toString("hex"), lines: [], seq: 0, status: "running", summary: null, subscribers: new Set(), statusSubs: new Set(), gcTimer: null };
      this.tasks.set(taskId, t);
    }
    return t.token;
  }

  tokenFor(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.token;
  }

  append(taskId: string, line: string, at: number): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const entry: ActivityLine = { line, at, seq: ++t.seq };
    t.lines.push(entry);
    if (t.lines.length > MAX_LINES) t.lines.shift();
    for (const cb of t.subscribers) {
      try {
        cb(entry);
      } catch {
        // a broken subscriber must not stall the stream
      }
    }
  }

  /** Mark the task settled with its final status + summary; buffer is retained briefly then GC'd. */
  settle(taskId: string, status: string, summary: string | null): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = status;
    t.summary = summary;
    for (const cb of t.statusSubs) {
      try {
        cb(status, summary);
      } catch {
        // ignore
      }
    }
    if (t.gcTimer) clearTimeout(t.gcTimer);
    t.gcTimer = setTimeout(() => this.tasks.delete(taskId), RETAIN_AFTER_SETTLE_MS);
    t.gcTimer.unref?.();
  }

  /** Internal (no token) view for in-process consumers like the Discord tail. */
  view(taskId: string): TaskView | null {
    const t = this.tasks.get(taskId);
    return t ? this.toView(t) : null;
  }

  /** Token-gated view for external consumers (the web stream). Constant-time token compare. */
  viewWithToken(taskId: string, token: string): TaskView | null {
    const t = this.tasks.get(taskId);
    if (!t || !tokensEqual(t.token, token)) return null;
    return this.toView(t);
  }

  private toView(t: TaskStream): TaskView {
    return {
      lines: [...t.lines],
      status: t.status,
      summary: t.summary,
      onLine: (cb) => {
        t.subscribers.add(cb);
        return () => t.subscribers.delete(cb);
      },
      onStatus: (cb) => {
        t.statusSubs.add(cb);
        return () => t.statusSubs.delete(cb);
      },
    };
  }
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

let singleton: ActivityHub | null = null;
export function getActivityHub(): ActivityHub {
  return (singleton ??= new ActivityHub());
}

/** The viewer URL for a task, or null when no public base is configured. */
export function taskViewUrl(baseUrl: string | undefined, taskId: string, token: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/tasks/${taskId}?key=${token}`;
}
