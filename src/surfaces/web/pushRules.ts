import type { Database } from "bun:sqlite";
import { z } from "zod";
import { isValidTimeZone } from "../../workspace/scheduler.ts";
import type { PushPayload } from "./push.ts";

export const PUSH_BODY_MAX = 140;
const TITLE = "sushii-agent";

/** What the web adapter pushes for. Deltas, tools, status and notices never push. */
export type PushEvent =
  | { kind: "approval"; nonce: string; tool: string }
  | { kind: "ask"; askId: string; question: string }
  | { kind: "auth" }
  | { kind: "reply" | "proactive"; text: string }
  | { kind: "interrupted" }
  | { kind: "quota"; usedBytes: number; capBytes: number };

/** Approvals and asks ring even in quiet hours; everything else goes out silent then, never dropped. */
export function pushFor(event: PushEvent, opts: { quiet: boolean }): PushPayload {
  const silent = opts.quiet ? { silent: true } : {};
  switch (event.kind) {
    case "approval":
      return { title: "Approval needed", body: `sushii-agent needs your approval to run ${event.tool}`, url: `/?approve=${encodeURIComponent(event.nonce)}`, tag: `approval:${event.nonce}`, requireInteraction: true };
    case "ask":
      return event.askId
        ? { title: "The agent asks", body: plainPushBody(event.question), url: `/?ask=${encodeURIComponent(event.askId)}`, tag: `ask:${event.askId}` }
        : { title: "The agent asks", body: plainPushBody(event.question), url: "/", tag: "chat" };
    case "auth":
      return { title: TITLE, body: "Sign-in link ready", url: "/", tag: "auth", ...silent };
    case "reply":
      return { title: TITLE, body: plainPushBody(event.text) || "Sent a file", url: "/", tag: "chat", renotify: false, ...silent };
    case "proactive":
      return { title: TITLE, body: plainPushBody(event.text) || "Sent a file", url: "/", tag: "chat", ...silent };
    case "interrupted":
      return { title: TITLE, body: "Turn interrupted", url: "/", tag: "chat", ...silent };
    case "quota":
      return { title: "Photo storage almost full", body: `${Math.round((event.usedBytes / event.capBytes) * 100)}% of the photo quota is used.`, url: "/", tag: "quota", ...silent };
  }
}

/** Markdown reduced to the words a notification shade can show, cut to PUSH_BODY_MAX code points. */
export function plainPushBody(text: string, max = PUSH_BODY_MAX): string {
  const plain = text
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(plain);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : plain;
}

// ── Quiet hours ──

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, start: "22:00", end: "08:00" };
const KV_KEY = "web:quiet_hours";

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes past local midnight in `timeZone`. */
export function localMinutes(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** A range whose end is before its start wraps past midnight; equal ends mean the whole day. */
export function isQuietAt(q: QuietHours, timeZone: string, at: number): boolean {
  if (!q.enabled) return false;
  const now = localMinutes(timeZone, at);
  const start = minutes(q.start);
  const end = minutes(q.end);
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function resolveTimeZone(raw: string | undefined): string {
  const tz = raw?.trim();
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

export class QuietHoursStore {
  constructor(
    private readonly db: Database,
    readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {}

  get(): QuietHours {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(KV_KEY);
    if (!row) return DEFAULT_QUIET_HOURS;
    try {
      const parsed = quietHoursSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : DEFAULT_QUIET_HOURS;
    } catch {
      return DEFAULT_QUIET_HOURS;
    }
  }

  set(q: QuietHours): void {
    this.db.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [KV_KEY, JSON.stringify(q)]);
  }

  isQuiet(): boolean {
    return isQuietAt(this.get(), this.timeZone, this.now());
  }
}
