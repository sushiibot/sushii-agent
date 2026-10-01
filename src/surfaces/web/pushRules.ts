import type { JobAlert } from "./events.ts";
import type { PushPayload } from "./push.ts";

export const PUSH_BODY_MAX = 140;
const TITLE = "sushii-agent";

/** What the web adapter pushes for. Deltas, tools, status and notices never push. */
export type PushEvent =
  | { kind: "approval"; nonce: string; tool: string }
  | { kind: "ask"; askId: string; question: string }
  | { kind: "auth" }
  | { kind: "reply" | "proactive"; text: string }
  | { kind: "inbox"; key: string; text: string }
  | { kind: "alert"; alert: Pick<JobAlert, "job" | "error"> & { kind: "failed" | "stuck" } }
  /** Replaces the job's failure notification in the tray, silently. */
  | { kind: "alertRecovered"; job: string }
  | { kind: "interrupted" }
  | { kind: "quota"; usedBytes: number; capBytes: number };

export function pushFor(event: PushEvent): PushPayload {
  switch (event.kind) {
    case "approval":
      return { title: "Approval needed", body: `sushii-agent needs your approval to run ${event.tool}`, url: `/?approve=${encodeURIComponent(event.nonce)}`, tag: `approval:${event.nonce}`, requireInteraction: true };
    case "ask":
      return event.askId
        ? { title: "The agent asks", body: plainPushBody(event.question), url: `/?ask=${encodeURIComponent(event.askId)}`, tag: `ask:${event.askId}` }
        : { title: "The agent asks", body: plainPushBody(event.question), url: "/chat", tag: "chat" };
    case "auth":
      return { title: TITLE, body: "Sign-in link ready", url: "/chat", tag: "auth" };
    case "reply":
      return { title: TITLE, body: plainPushBody(event.text) || "Sent a file", url: "/chat", tag: "chat", renotify: false };
    case "proactive":
      return { title: TITLE, body: plainPushBody(event.text) || "Sent a file", url: "/chat", tag: "chat" };
    case "inbox":
      return { title: TITLE, body: plainPushBody(event.text), url: `/?item=${encodeURIComponent(`msg:${event.key}`)}`, tag: `msg:${event.key}` };
    case "alert": {
      const { job, error } = event.alert;
      const body = error ? plainPushBody(`${job}: ${error}`) : job;
      // The job name already matched JOB_NAME_RE, so it needs no escaping in the URL.
      // renotify: a new streak's push replaces the last one's notification, and must still ring.
      return { title: event.alert.kind === "stuck" ? "Scheduled job stuck" : "Scheduled job failed", body, url: `/home?item=job:${job}`, tag: `job:${job}`, renotify: true };
    }
    case "alertRecovered":
      return { title: "Scheduled job working again", body: event.job, url: "/home", tag: `job:${event.job}`, silent: true };
    case "interrupted":
      return { title: TITLE, body: "Turn interrupted", url: "/chat", tag: "chat" };
    case "quota":
      return { title: "Photo storage almost full", body: `${Math.round((event.usedBytes / event.capBytes) * 100)}% of the photo quota is used.`, url: "/", tag: "quota" };
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
