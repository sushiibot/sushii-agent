import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { redact } from "./wsRuns.ts";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/** Every flush prompt starts with this; chat messages always start with a header, so they can't spoof it. */
export const FLUSH_MARKER = "[memory flush]";

export type FlushReason = "new" | "compaction";

const FLUSH_WHY: Record<FlushReason, string> = {
  new: "The session is about to reset.",
  compaction: "The context is about to be compacted; older detail will be summarized away.",
};

export function flushPrompt(reason: FlushReason): string {
  return (
    `${FLUSH_MARKER} ${FLUSH_WHY[reason]} Write anything durable from this session to MEMORY.md / USER.md / ` +
    "today's memory/ log per AGENTS.md. Reply NO_REPLY."
  );
}

/** Under the bot's chat/new request timeout, which also covers the commit and building the new session. */
export const FLUSH_TIMEOUT_MS = 180_000;

/** Room left below Pi's compaction trigger for the flush turn's own reads and edits. */
export function flushMarginTokens(contextWindow: number): number {
  return Math.max(20_000, Math.floor(contextWindow * 0.1));
}

const MEMORY_FILES = ["USER.md", "MEMORY.md", "DREAMS.md"];

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

/** Whether a flush prompt was sent since the latest compaction on this branch. */
export function flushRanThisCycle(entries: SessionEntry[]): boolean {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") {
      start = i + 1;
      break;
    }
  }
  return entries.slice(start).some((e) => e.type === "message" && e.message.role === "user" && textOf(e.message.content).startsWith(FLUSH_MARKER));
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A short, redacted note of what the compacted span was about, or null when it has nothing worth keeping. */
export function buildHandoff(preparation: Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages" | "fileOps">, reason: string, now: Date): string | null {
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const asks = messages
    .filter((m) => m.role === "user")
    .map((m) => oneLine(textOf((m as { content: unknown }).content)))
    .filter((t) => t && !t.startsWith(FLUSH_MARKER))
    .slice(-3);
  const lastReply = messages
    .filter((m) => m.role === "assistant")
    .map((m) => oneLine(textOf((m as { content: unknown }).content)))
    .filter(Boolean)
    .at(-1);
  const files = [...new Set([...preparation.fileOps.edited, ...preparation.fileOps.written])].slice(0, 10);
  if (!asks.length && !lastReply && !files.length) return null;

  const time = now.toISOString().slice(11, 16);
  const lines = [``, `## Compaction handoff ${time} UTC (${reason}; no memory flush ran)`, ``];
  if (asks.length) {
    lines.push("Last asks:");
    for (const a of asks) lines.push(`- ${clip(a, 300)}`);
  }
  if (lastReply) lines.push(`Last reply (may list open items): ${clip(lastReply, 500)}`);
  if (files.length) lines.push(`Files changed: ${files.join(", ")}`);
  return `${redact(lines.join("\n"))}\n`;
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
        const block = buildHandoff(event.preparation, event.reason, now);
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
