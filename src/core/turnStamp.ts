import type { ModelMessage } from "ai";

// Every user turn is persisted with a leading `[Sat 2026-09-27 2:40 PM UTC]` stamp so a conversation
// resumed days later shows the model how much time passed. The time lives in the message, not the
// system prompt, so the cached prompt prefix doesn't change every minute.

const GAP_NOTE_AFTER_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const STAMP_RE = /^\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) (AM|PM) UTC(?: · [^\]]*)?\] /;

const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });

export function formatStamp(at: Date): string {
  const y = at.getUTCFullYear();
  const mo = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  const h24 = at.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mi = String(at.getUTCMinutes()).padStart(2, "0");
  return `${dateFmt.format(at)} ${y}-${mo}-${d} ${h}:${mi} ${h24 < 12 ? "AM" : "PM"} UTC`;
}

function describeGap(ms: number): string {
  if (Math.round(ms / HOUR_MS) >= 24) {
    const days = Math.round(ms / DAY_MS);
    return `${days} day${days === 1 ? "" : "s"} later`;
  }
  const hours = Math.round(ms / HOUR_MS);
  return `${hours} hour${hours === 1 ? "" : "s"} later`;
}

/** When a stamped user message was sent, or undefined for an unstamped (pre-stamp) message. */
export function parseStamp(text: string): Date | undefined {
  const m = STAMP_RE.exec(text);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, ampm] = m;
  const hour = (Number(h) % 12) + (ampm === "PM" ? 12 : 0);
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi)));
}

/** `text` without its leading send-time stamp, for consumers that want only what the user wrote. */
export function stripStamp(text: string): string {
  return text.replace(STAMP_RE, "");
}

/** The send time of the most recent stamped user message in `messages`. */
export function lastUserStamp(messages: ModelMessage[]): Date | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const at = parseStamp(m.content);
    if (at) return at;
  }
  return undefined;
}

/** Prefix `text` with its send time, plus a gap note when the previous user message is old enough
 *  that the model shouldn't treat the conversation as continuous. */
export function stampUserText(text: string, at: Date, previous: Date | undefined): string {
  const gap = previous ? at.getTime() - previous.getTime() : 0;
  const note = gap >= GAP_NOTE_AFTER_MS ? ` · ${describeGap(gap)}` : "";
  return `[${formatStamp(at)}${note}] ${text}`;
}
