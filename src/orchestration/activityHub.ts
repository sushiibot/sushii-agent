import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BrowserUpdate } from "./contracts.ts";

// In-memory live activity per task: a capped ring of recent lines + fan-out to live viewers (the
// Discord tail and the web stream). Not persisted — a task's stream lives only while it runs and for
// a short window after, which matches the no-catch-up model (a runner reconnect fails in-flight
// tasks anyway). The full transcript still lives in the runner's session file.

export interface ActivityLine {
  line: string;
  at: number;
  seq: number; // monotonic per task — the SSE event id, for de-dup + Last-Event-ID resume
  atype: "tool" | "result" | "text";
}

// Static task context for the header/panels: which runner + where, which project + path, and how to
// resume from a terminal (null when not cleanly resumable outside the bot).
export interface TaskMeta {
  runnerId: string;
  kind: string;
  location: string | null;
  project: string | null;
  cwd: string | null;
  nativeSessionId: string | null;
  resumeCommand: string | null;
}

// A blocked task's outstanding question (ask_owner). choices, when present, are offered as buttons.
export interface PendingAsk {
  askId: string;
  question: string;
  choices?: string[];
}

// Latest known state of a task's browser. Only the newest frame is kept: the view is live, not a recording.
export interface BrowserState {
  supported: boolean | null; // null = not yet known
  connected: boolean;
  frame: string | null;
  width: number | null;
  height: number | null;
  url: string | null;
  title: string | null;
}

interface TaskStream {
  token: string;
  lines: ActivityLine[];
  seq: number;
  meta: TaskMeta | null;
  status: string; // "running" | "idle" | "done" | "failed"
  summary: string | null;
  pendingAsk: PendingAsk | null;
  subscribers: Set<(l: ActivityLine) => void>;
  statusSubs: Set<(status: string, summary: string | null) => void>;
  askSubs: Set<(ask: PendingAsk | null) => void>;
  browser: BrowserState;
  browserSubs: Set<(u: BrowserUpdate) => void>;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_LINES = 500; // ring cap per task (memory bound)
const RETAIN_AFTER_SETTLE_MS = 10 * 60_000; // keep a settled task's buffer this long for late viewers

export interface TaskView {
  lines: ActivityLine[];
  status: string;
  summary: string | null;
  meta: TaskMeta | null;
  pendingAsk: PendingAsk | null;
  browser: BrowserState;
  /** Subscribe to browser updates. The first subscriber starts the runner's relay, the last one stops it. */
  onBrowser: (cb: (u: BrowserUpdate) => void) => () => void;
  /** Subscribe to new lines; returns an unsubscribe fn. */
  onLine: (cb: (l: ActivityLine) => void) => () => void;
  /** Subscribe to status/summary changes (settle); returns an unsubscribe fn. */
  onStatus: (cb: (status: string, summary: string | null) => void) => () => void;
  /** Subscribe to pending-ask changes (a new question, or null when answered); unsubscribe fn returned. */
  onAsk: (cb: (ask: PendingAsk | null) => void) => () => void;
}

export class ActivityHub {
  private readonly tasks = new Map<string, TaskStream>();
  private browserWatch: ((taskId: string, watch: boolean) => void) | null = null;

  /** Called when a task's browser view gains its first viewer or loses its last one. */
  setBrowserWatchHandler(fn: (taskId: string, watch: boolean) => void): void {
    this.browserWatch = fn;
  }

  /** Begin (or return) a task's stream; returns its viewer token. Idempotent. */
  open(taskId: string): string {
    let t = this.tasks.get(taskId);
    if (!t) {
      t = { token: randomBytes(16).toString("hex"), lines: [], seq: 0, meta: null, status: "running", summary: null, pendingAsk: null, subscribers: new Set(), statusSubs: new Set(), askSubs: new Set(), browser: emptyBrowser(), browserSubs: new Set(), gcTimer: null };
      this.tasks.set(taskId, t);
    } else if (t.gcTimer || t.status !== "running") {
      // Re-opening a settled task (a resume) — cancel its pending GC and mark it running again so late
      // viewers hold the stream open and the buffer + subscribers survive into the resumed turn.
      if (t.gcTimer) clearTimeout(t.gcTimer);
      t.gcTimer = null;
      t.status = "running";
      t.summary = null;
    }
    return t.token;
  }

  tokenFor(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.token;
  }

  setMeta(taskId: string, meta: TaskMeta): void {
    const t = this.tasks.get(taskId);
    if (t) t.meta = meta;
  }

  /** Record a task's outstanding question (ask_owner) and notify viewers. */
  setAsk(taskId: string, ask: PendingAsk): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.pendingAsk = ask;
    for (const cb of t.askSubs) {
      try {
        cb(ask);
      } catch {
        // a broken subscriber must not stall the others
      }
    }
  }

  /** Clear a task's outstanding question (answered/stopped) and notify viewers. */
  clearAsk(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (!t || !t.pendingAsk) return;
    t.pendingAsk = null;
    for (const cb of t.askSubs) {
      try {
        cb(null);
      } catch {
        // ignore
      }
    }
  }

  append(taskId: string, line: string, at: number, atype: ActivityLine["atype"]): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const entry: ActivityLine = { line, at, seq: ++t.seq, atype };
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

  pushBrowser(taskId: string, update: BrowserUpdate): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const b = t.browser;
    if (update.supported !== undefined) b.supported = update.supported;
    if (update.connected !== undefined) b.connected = update.connected;
    if (update.frame !== undefined) b.frame = update.frame;
    if (update.width !== undefined) b.width = update.width;
    if (update.height !== undefined) b.height = update.height;
    if (update.url !== undefined) b.url = update.url;
    if (update.title !== undefined) b.title = update.title;
    for (const cb of t.browserSubs) {
      try {
        cb(update);
      } catch {
        // a broken subscriber must not stall the others
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
    return t ? this.toView(taskId, t) : null;
  }

  /** Token-gated view for external consumers (the web stream). Constant-time token compare. */
  viewWithToken(taskId: string, token: string): TaskView | null {
    const t = this.tasks.get(taskId);
    if (!t || !tokensEqual(t.token, token)) return null;
    return this.toView(taskId, t);
  }

  private toView(taskId: string, t: TaskStream): TaskView {
    return {
      lines: [...t.lines],
      status: t.status,
      summary: t.summary,
      meta: t.meta,
      pendingAsk: t.pendingAsk,
      browser: { ...t.browser },
      onBrowser: (cb) => {
        t.browserSubs.add(cb);
        if (t.browserSubs.size === 1) this.browserWatch?.(taskId, true);
        return () => {
          if (t.browserSubs.delete(cb) && t.browserSubs.size === 0) this.browserWatch?.(taskId, false);
        };
      },
      onLine: (cb) => {
        t.subscribers.add(cb);
        return () => t.subscribers.delete(cb);
      },
      onStatus: (cb) => {
        t.statusSubs.add(cb);
        return () => t.statusSubs.delete(cb);
      },
      onAsk: (cb) => {
        t.askSubs.add(cb);
        return () => t.askSubs.delete(cb);
      },
    };
  }
}

function emptyBrowser(): BrowserState {
  return { supported: null, connected: false, frame: null, width: null, height: null, url: null, title: null };
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
