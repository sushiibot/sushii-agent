import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { redact } from "./secretPatterns.ts";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/** Every flush prompt starts with this; chat messages always start with a header, so they can't spoof it. */
export const FLUSH_MARKER = "[memory flush]";

export type FlushReason = "new" | "compaction" | "rotate";

const FLUSH_WHY: Record<FlushReason, string> = {
  new: "The session is about to reset.",
  compaction: "The context is about to be compacted; older detail will be summarized away.",
  rotate: "The session is idle and about to be replaced by a fresh one that starts from a recap.",
};

export function flushPrompt(reason: FlushReason): string {
  return (
    `${FLUSH_MARKER} ${FLUSH_WHY[reason]} Write anything durable from this session to MEMORY.md / USER.md / ` +
    "today's memory/ log per AGENTS.md. Never save exact coordinates from request_current_location: they are one-time task context, not durable memory. Reply NO_REPLY."
  );
}

/** Cap on a chat/new flush turn; the NEW_BUDGET_MS deadline usually binds first. */
export const FLUSH_TIMEOUT_MS = 180_000;

/** Cap on a pre-compaction flush: inbound messages and /stop wait behind it. */
export const COMPACTION_FLUSH_TIMEOUT_MS = 90_000;

/**
 * The whole chat/new: any soft flush ahead of it, waiting out compaction, the flush, the abort, the commit
 * and the new session. Under the bot's 240s chat/new timeout (link.ts NEW_SESSION_TIMEOUT_MS).
 */
export const NEW_BUDGET_MS = 210_000;

/** Kept back from a chat/new flush for the abort, commit and new session; scales down with small test budgets. */
export function newFinishReserveMs(budgetMs: number): number {
  return Math.min(15_000, Math.floor(budgetMs / 10));
}

/** Below this much time left, chat/new skips the flush and writes the handoff note instead. */
export function newMinFlushMs(budgetMs: number): number {
  return Math.min(20_000, Math.floor(budgetMs / 10));
}

/**
 * Room left below Pi's compaction trigger for the flush turn's own reads and edits; sized from the trigger,
 * since 15% of a large window can exceed the trigger itself. Pi also compacts mid-run and at run end before settling (agent-session.js 402/519, 1377), so a tool-heavy turn often
 * jumps the band; the session_before_compact handoff is the expected path for those.
 */
export function flushMarginTokens(trigger: number): number {
  return Math.max(20_000, Math.floor(trigger * 0.15));
}

const MEMORY_FILES = ["USER.md", "MEMORY.md", "DREAMS.md", "TASKS.md"];

/** A cheap fingerprint (name, size, mtime) of the tracked memory files; any write changes it. */
export function memoryFilesSignature(home: string): string {
  const parts: string[] = [];
  const add = (rel: string) => {
    try {
      const st = statSync(join(home, rel));
      if (st.isFile()) parts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      // Missing: absent from the signature, so a deletion is a change too.
    }
  };
  for (const f of MEMORY_FILES) add(f);
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(home, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const child = `${rel}/${name}`;
      try {
        if (statSync(join(home, child)).isDirectory()) walk(child);
        else add(child);
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };
  walk("memory");
  walk("tasks");
  return parts.join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

const isFlushPrompt = (m: { role?: string; content?: unknown }) => m.role === "user" && textOf(m.content).startsWith(FLUSH_MARKER);

/**
 * Whether a flush completed since the latest compaction on this branch: a flush prompt whose run's last
 * assistant message didn't end aborted or in error. A flush still running (no reply yet, nothing after it) counts.
 */
export function flushRanThisCycle(entries: SessionEntry[]): boolean {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") {
      start = i + 1;
      break;
    }
  }
  const messages = entries.slice(start).flatMap((e) => (e.type === "message" ? [e.message as { role?: string; content?: unknown; stopReason?: string }] : []));
  for (let i = 0; i < messages.length; i++) {
    if (!isFlushPrompt(messages[i]!)) continue;
    let last: { stopReason?: string } | undefined;
    let j = i + 1;
    for (; j < messages.length && messages[j]!.role !== "user"; j++) {
      if (messages[j]!.role === "assistant") last = messages[j];
    }
    if (!last) {
      if (j === messages.length) return true;
      continue;
    }
    if (last.stopReason !== "aborted" && last.stopReason !== "error") return true;
  }
  return false;
}

/** flushRanThisCycle for a live Pi AgentSession; false for anything without a session manager (test fakes). */
export function sessionFlushRanThisCycle(session: unknown): boolean {
  const manager = (session as { sessionManager?: { getBranch?: () => SessionEntry[] } }).sessionManager;
  return typeof manager?.getBranch === "function" ? flushRanThisCycle(manager.getBranch()) : false;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface HandoffInput {
  messages: ReadonlyArray<{ role: string; content?: unknown }>;
  files?: Iterable<string>;
}

/** A short, redacted note of what a conversation span was about, or null when it has nothing worth keeping. */
export function buildHandoff(input: HandoffInput, heading: { title: string; detail: string }, now: Date): string | null {
  const messages = input.messages;
  const asks = messages
    .filter((m) => m.role === "user")
    .map((m) => oneLine(textOf(m.content)))
    .filter((t) => t && !t.startsWith(FLUSH_MARKER))
    .slice(-3);
  const lastReply = messages
    .filter((m) => m.role === "assistant")
    .map((m) => oneLine(textOf(m.content)))
    .filter(Boolean)
    .at(-1);
  const files = [...new Set(input.files ?? [])].slice(0, 10);
  if (!asks.length && !lastReply && !files.length) return null;

  const time = now.toISOString().slice(11, 16);
  const lines = [``, `## ${heading.title} ${time} UTC (${heading.detail})`, ``];
  if (asks.length) {
    lines.push("Last asks:");
    for (const a of asks) lines.push(`- ${clip(a, 300)}`);
  }
  // Assistant text can echo web or tool output, so whoever reads this note back must not act on it.
  if (lastReply) lines.push(`Last reply (unverified assistant text; may list open items): ${clip(lastReply, 500)}`);
  if (files.length) lines.push(`Files changed: ${files.join(", ")}`);
  return `${redact(lines.join("\n"))}\n`;
}

export function compactionHandoff(preparation: Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages" | "fileOps">, reason: string, now: Date): string | null {
  return buildHandoff(
    {
      messages: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
      files: [...preparation.fileOps.edited, ...preparation.fileOps.written],
    },
    { title: "Compaction handoff", detail: `${reason}; no memory flush ran` },
    now,
  );
}

/** The deterministic fallback when chat/new couldn't run a full flush; returns the note's path, or null when nothing was written. */
export function writeResetHandoff(home: string, messages: ReadonlyArray<{ role: string; content?: unknown }>, outcome: string, now: Date = new Date()): string | null {
  const block = buildHandoff({ messages }, { title: "Reset handoff", detail: `memory flush ${outcome}` }, now);
  return block ? appendDailyNote(home, now, block) : null;
}

export function appendDailyNote(home: string, now: Date, text: string): string {
  const dir = join(home, "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().slice(0, 10)}.md`);
  appendFileSync(path, text);
  return path;
}

/**
 * Deterministic fallback for a compaction no agentic flush preceded (e.g. one run jumped past the trigger,
 * or Pi compacted between tool calls): appends a handoff to today's daily note. Stateless, since
 * session.reload() re-runs extension factories.
 */
export function createCompactionHandoffExtension(opts: { home: string; log: Log; now?: () => Date }): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", (event) => {
      try {
        if (flushRanThisCycle(event.branchEntries)) return undefined;
        const now = opts.now?.() ?? new Date();
        const block = compactionHandoff(event.preparation, event.reason, now);
        if (!block) return undefined;
        const path = appendDailyNote(opts.home, now, block);
        opts.log.info({ reason: event.reason, path }, "wrote a compaction handoff to the daily note");
      } catch (err) {
        opts.log.warn({ err }, "compaction handoff failed; compacting anyway");
      }
      return undefined;
    });
  };
}
